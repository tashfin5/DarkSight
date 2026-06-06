/* =============================
   DARK PATTERN DETECTOR
   FINAL STABLE VERSION (FIXED)
============================= */

const DEBUG = true;

function log(...a){
if(DEBUG) console.log("[DP]",...a);
}

let MODE="HLE";

/* =============================
   GLOBAL STATE
============================= */

const processedElements = new WeakSet();
const textCache = new Map();
const explainedTexts = new Set();
const pendingLLM = new Set();
const llmQueue = [];

let scanTimer=null;
let scanning=false;
let llmRunning = false;

let explanationsVisible=true;

// Optimization: IntersectionObserver to only process visible elements
const elementMap = new Map(); // normalizedText -> Set of elements
const observedNodes = new Map(); // element -> normalizedText

const visibilityObserver = new IntersectionObserver((entries) => {
    let triggered = false;
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const el = entry.target;
            const key = observedNodes.get(el);
            
            if (key) {
                if (!textCache.has(key) && !pendingLLM.has(key)) {
                    pendingLLM.add(key);
                    llmQueue.push(key);
                    triggered = true;
                } else if (textCache.has(key)) {
                    // Apply cached result immediately
                    applyMode(el, textCache.get(key));
                }
            }
            
            visibilityObserver.unobserve(el);
            observedNodes.delete(el);
        }
    });
    
    if (triggered) {
        processQueue();
    }
}, { rootMargin: '200px' }); // Pre-fetch slightly off-screen elements

/* =============================
   MODE
============================= */

chrome.storage.local.get(["dp_mode"],res=>{
MODE=res.dp_mode||"HLE";
});

chrome.storage.local.get(["dp_mode", "dp_enabled", "disabled_sites"], res => {
    MODE=res.dp_mode||"HLE";
    
    const disabledSites = res.disabled_sites || [];
    const isSiteDisabled = disabledSites.includes(window.location.hostname);
    
    if(document.body && (res.dp_enabled === false || isSiteDisabled)) {
        document.body.classList.add("dp-feature-disabled");
    }
});

/* =============================
   NORMALIZE TEXT
============================= */

function normalizeText(text){
let t=text.toLowerCase();
t=t.replace(/\d{1,2}:\d{2}:\d{2}/g,"TIMER");
// Removed PERCENT replacement to allow LLM to see actual % signs for discounts
return t;
}

/* =============================
   EXTRACT TEXT NODES
============================= */

function extractNodes(){
const ignoredElements = ["p", "script", "style", "noscript", "br", "hr"];
const els=document.querySelectorAll("*");
const nodes=[];

els.forEach(el=>{
if(processedElements.has(el)) return;

// Ignore our own extension UI elements
if(el.classList && (el.classList.contains("dp-explain") || el.classList.contains("dp-highlight"))) return;
if(el.closest(".dp-explain") || el.closest("#dp-toggle") || el.id === "dp-toggle") return;

const tag = el.tagName.toLowerCase();
if(ignoredElements.includes(tag)) return;

// Must not contain child elements (leaf nodes)
if(el.children.length > 0) return;

const text=el.innerText?.trim();
if(!text) return;

const lower=text.toLowerCase();

// Thesis Data Preprocessing: Remove single words, numbers only, and prices.
if(lower.split(/\s+/).length < 2) return;
if(/^[\d\W]+$/.test(lower)) return;
if(/[\$\€\£\¥\৳]\s*\d+/.test(lower)) return;
// Removed aggressive blacklist so promotional buttons (Shop Now, Free Delivery, App Downloads) can be analyzed
const cleanText = lower.replace(/[!.,]/g, '').trim();
const exactBlacklist = new Set([
    "view more",
    "show more",
    "help & support",
    "login",
    "sign up",
    "search in daraz"
]);

if(exactBlacklist.has(cleanText)) return;

// Lowered length restriction from 8 to 4 to catch short badges like '50% OFF', 'SALE'
if(lower.length<4||lower.length>150) return;

const rect=el.getBoundingClientRect();
if(rect.width<20 || rect.height<10) return;
if(rect.width>600 || rect.height>150) return;
if(el.closest("nav") || el.closest("header")) return;

nodes.push({
element:el,
text:lower,
normalized:normalizeText(lower)
});
});

return nodes;
}

/* =============================
   LLM
============================= */

async function classifyLLM(texts){
if(!texts.length) return[];

// Safety check: Prevent crash if extension is reloaded/context is invalidated
if(typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return [];
}

try{
log("Sending to LLM via background:",texts);
const prompt=buildPrompt(texts);

const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LLM request timed out after 30s")), 30000);
    chrome.runtime.sendMessage({ action: "fetchLLM", prompt: prompt }, res => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!res) reject(new Error("No response from background script"));
        else if (!res.success) reject(new Error(res.error));
        else resolve(res.data);
    });
});

const data = response;
const results=[];

// Log the actual LLM output so we can see what Mistral generated
log("Mistral response:", data.response);

data.response.split("\n").forEach(line=>{
const p=line.split("|");
if(p.length<2) return;
const id = parseInt(p[0].trim(), 10);
let fullCategoryStr = p.slice(1).join("|").trim(); // Captures "Category: Explanation"

const lowerStr = fullCategoryStr.toLowerCase();

// Valid 8 core categories
const validCategories = [
    "misdirection", "urgency", "scarcity", 
    "social proof", "obstruction", "forced action", "sneaking", "fake discount"
];

// STRICT FILTERING: Check if the LLM explicitly flagged one of the 7 core categories.
const isDarkPattern = validCategories.some(cat => lowerStr.includes(cat));

if (!isDarkPattern || lowerStr.includes("not dark") || lowerStr.includes("normal") || lowerStr === "id | normal") {
    // Completely ignore and discard this element
    return;
}

// Fallback if Mistral forgets the colon and explanation format
if (!fullCategoryStr.includes(":")) {
    // Extract whichever category matched and append generic explanation
    const matchedCategory = validCategories.find(cat => lowerStr.includes(cat));
    const titleCaseCat = matchedCategory ? (matchedCategory.charAt(0).toUpperCase() + matchedCategory.slice(1)) : "Dark Pattern";
    fullCategoryStr = `${titleCaseCat}: Manipulative design pattern detected.`;
}

if (!isNaN(id) && id >= 0 && id < texts.length) {
    results.push({ 
        text: texts[id], 
        category: fullCategoryStr 
    });
}
});

return results;
}catch(e){
if (e.message.includes("Extension context invalidated")) {
    // Suppress context invalidated errors when reloading extension
    return [];
}
console.warn("LLM error:", e.message);
texts.forEach(t => pendingLLM.delete(t));
return [];
}
}

// Explanation UI logic has been moved purely to styles.css via hover tooltips


function highlight(el,category){
if(el.closest(".dp-highlight")) return;
processedElements.add(el);
el.classList.add("dp-highlight");
el.setAttribute("data-dp-category", category);
}

/* =============================
   HIDE
============================= */

function hide(el, category){
processedElements.add(el);
if(category) el.setAttribute("data-dp-category", category);
el.classList.add("dp-hidden-element");

const isEnabled = !document.body.classList.contains("dp-feature-disabled");
if(isEnabled){
    el.style.display="none";
}
}

/* =============================
   SWITCH (COUNTERMEASURE)
============================= */

function switchText(el, info){
if(!el.dataset.original){
el.dataset.original = el.innerText;
}

if(info && info.category) {
el.dataset.dpCategory = info.category;
}

const isEnabled = !document.body.classList.contains("dp-feature-disabled");

if(isEnabled){
let rep="[Manipulative text neutralized]";
const cat = (el.dataset.dpCategory || "").toLowerCase();

// Schaefer 2024 Dynamic Countermeasures
if(cat.includes("urgency")) rep="[Promotional deadline hidden to reduce pressure]";
else if(cat.includes("scarcity")) rep="[Stock indicator hidden to reduce pressure]";
else if(cat.includes("social proof")) rep="[Popularity metric hidden to reduce pressure]";
else if(cat.includes("sneaking")) rep="[Hidden costs/actions neutralized]";
else if(cat.includes("misdirection")) rep="[Misleading phrasing neutralized]";
else if(cat.includes("forced action")) rep="[Forced action prompt neutralized]";
else if(cat.includes("obstruction")) rep="[Obstruction bypassed]";

el.innerText = rep;
el.classList.add("dp-neutralized");
}else{
el.innerText = el.dataset.original;
el.classList.remove("dp-neutralized");
}
}

/* =============================
   APPLY MODE
============================= */

function applyMode(el,info){
if(!info) return;
if(info.category.toLowerCase().includes("not dark") || info.category.toLowerCase().includes("normal")) return;
if(MODE==="UC") return;

if(MODE==="HLE") highlight(el,info.category);
if(MODE==="HD") hide(el,info.category);
if(MODE==="SW"){
switchText(el, info);
return;
}
}

/* =============================
   DYNAMIC MODE UPDATES
============================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "getCounts") {
        const allDetected = document.querySelectorAll('[data-dp-category]');
        let textCount = 0;
        let visCount = 0;
        
        allDetected.forEach(el => {
            if (el.classList.contains('dp-visual-element') || el.classList.contains('dp-visual-box')) {
                visCount++;
            } else {
                textCount++;
            }
        });
        
        sendResponse({
            textualCount: textCount,
            structuralCount: 0,
            visualCount: visCount
        });
        return;
    }
    
    if (msg.action === "updateMode") {
        MODE = msg.mode;
        // Re-apply the mode to all processed elements without reloading the page
        document.querySelectorAll(".dp-highlight, [data-original], .dp-hidden-element").forEach(el => {
            // First revert everything to clean state
            if(el.dataset.original) {
                el.innerText = el.dataset.original;
                el.classList.remove("dp-neutralized");
            }
            if(el.classList.contains("dp-highlight")) {
                el.classList.remove("dp-highlight");
            }
            if(el.classList.contains("dp-hidden-element")) {
                el.style.display = "";
                el.classList.remove("dp-hidden-element");
            }
            
            // Re-apply based on new mode
            if (MODE === "HLE" && el.dataset.dpCategory) {
                highlight(el, el.dataset.dpCategory);
            } else if (MODE === "HD" && el.dataset.dpCategory) {
                hide(el, el.dataset.dpCategory);
            } else if (MODE === "SW" && el.dataset.dpCategory) {
                switchText(el, {category: el.dataset.dpCategory});
            }
        });

// Removed createButton from updateMode as the toggle now lives in the popup
    } else if (msg.action === "toggleFeature" || msg.action === "toggleSite") {
        const isDisabled = msg.action === "toggleFeature" ? !msg.enabled : msg.disabledForSite;
        
        if (isDisabled) {
            document.body.classList.add("dp-feature-disabled");
            // Revert all dynamic mode changes
            document.querySelectorAll(".dp-highlight, [data-original], .dp-hidden-element").forEach(el => {
                if (el.dataset.original) {
                    el.innerText = el.dataset.original;
                    el.classList.remove("dp-neutralized");
                }
                if (el.classList.contains("dp-hidden-element")) {
                    el.style.display = "";
                }
            });
        } else {
            document.body.classList.remove("dp-feature-disabled");
            // Re-apply current mode
            document.querySelectorAll("[data-dp-category]").forEach(el => {
                if (MODE === "SW") {
                    switchText(el, {category: el.dataset.dpCategory});
                } else if (MODE === "HD") {
                    hide(el, el.dataset.dpCategory);
                }
            });
        }
    }
});

/* =============================
   REMOVED INTRUSIVE ON-PAGE BUTTON
============================= */

/* =============================
   SCAN
============================= */

async function scan(){
if(scanning) return;
const isEnabled = !document.body.classList.contains("dp-feature-disabled");
if(!isEnabled) {
    processQueue(); // flush any pending
    return;
}
scanning = true;

const nodes = extractNodes();

if(nodes.length === 0){
scanning = false;
return;
}

nodes.forEach(n=>{
const key = n.normalized;

if(!elementMap.has(key)) elementMap.set(key, new Set());
elementMap.get(key).add(n.element);

if(textCache.has(key)) return;

observedNodes.set(n.element, key);
visibilityObserver.observe(n.element);
});

/* apply cached results */
elementMap.forEach((elements, key) => {
const info = textCache.get(key);
if(!info) return;
elements.forEach(el=>{
applyMode(el,info);
});
});

// createButton removed
scanning=false;
processQueue();
}

async function processQueue(){
if(llmRunning) return;
if(llmQueue.length === 0) return;

llmRunning = true;
const batch = llmQueue.splice(0,6);
const results = await classifyLLM(batch);

results.forEach(r=>{
const key = normalizeText(r.text);
textCache.set(key,r);
pendingLLM.delete(key);

if(elementMap.has(key)) {
    const validElements = new Set();
    elementMap.get(key).forEach(el => {
        if (el.isConnected) {
            applyMode(el, r);
            validElements.add(el);
        }
    });
    elementMap.set(key, validElements);
}
});

llmRunning = false;
schedule();
processQueue();

// Broadcast new count to popup if open
try {
    chrome.runtime.sendMessage({
        action: "updateCount",
        textualCount: document.querySelectorAll('[data-dp-category]:not(.dp-visual-element):not(.dp-visual-box)').length
    }).catch(() => {});
} catch(e) {
    // Ignore context invalidated errors on reload
}
}

/* =============================
   DEBOUNCE
============================= */

function schedule(){
if(scanTimer) clearTimeout(scanTimer);
scanTimer=setTimeout(scan,1000);
}

// Trigger first scan
setTimeout(scan, 1000);
setInterval(scan, 3000);

/* =============================
   GLOBAL FLOATING TOOLTIP
============================= */

let globalTooltip = document.createElement("div");
globalTooltip.id = "dp-global-tooltip";
if (document.body) document.body.appendChild(globalTooltip);

document.addEventListener("mouseover", (e) => {
    const target = e.target.closest(".dp-highlight");
    if(target && !document.body.classList.contains("dp-feature-disabled")) {
        let cat = target.dataset.dpCategory;
        if(cat) {
            globalTooltip.innerText = cat;
            globalTooltip.style.display = "block";
            
            // Initial positioning
            const rect = target.getBoundingClientRect();
            globalTooltip.style.left = (rect.left + rect.width / 2) + "px";
            globalTooltip.style.top = rect.top + "px";
        }
    }
});

document.addEventListener("mouseout", (e) => {
    const target = e.target.closest(".dp-highlight");
    if(target) {
        if (e.relatedTarget && e.relatedTarget.closest(".dp-highlight") === target) {
            return;
        }
        globalTooltip.style.display = "none";
    }
});

document.addEventListener("mousemove", (e) => {
    if(globalTooltip.style.display === "block") {
        // Position it relative to the mouse cursor to ensure it's always visible
        globalTooltip.style.left = (e.clientX + 15) + "px";
        globalTooltip.style.top = (e.clientY + 15) + "px";
    }
});

/* =============================
   START
============================= */

setTimeout(scan,1500);
let observerCooldown=false;

const observer=new MutationObserver(()=>{
if(observerCooldown) return;
observerCooldown=true;
schedule();
setTimeout(()=>{
observerCooldown=false;
},2000);
});

observer.observe(document.body,{
childList:true,
subtree:true
});

window.addEventListener("load",schedule);