const buttons=document.querySelectorAll(".mode-btn");

const toggleBtn = document.getElementById("master-toggle");
const siteToggleBtn = document.getElementById("site-toggle");

let currentHostname = "";

chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if(tabs[0] && tabs[0].url) {
        try {
            const url = new URL(tabs[0].url);
            currentHostname = url.hostname;
        } catch(e) {}
    }

    chrome.storage.local.get(["dp_mode", "dp_enabled", "disabled_sites"],res=>{

        const current=res.dp_mode || "HLE";
        const enabled = res.dp_enabled !== false; // Default true
        const disabledSites = res.disabled_sites || [];

        buttons.forEach(btn=>{
        if(btn.dataset.mode===current){
        btn.classList.add("active");
        }
        });

        if(toggleBtn) {
            toggleBtn.checked = enabled;
        }
        
        if(siteToggleBtn && currentHostname) {
            siteToggleBtn.checked = disabledSites.includes(currentHostname);
        } else if (siteToggleBtn) {
            siteToggleBtn.disabled = true; // Disable if we can't get hostname (e.g. chrome:// pages)
        }

    });
    
    // Fetch counts
    if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {action: "getCounts"}, function(response) {
            if (!chrome.runtime.lastError && response) {
                const txt = document.getElementById("text-count");
                if(txt) txt.innerText = response.textualCount || 0;
                const struct = document.getElementById("struct-count");
                if(struct) struct.innerText = response.structuralCount || 0;
                const vis = document.getElementById("visual-count");
                if(vis) vis.innerText = response.visualCount || 0;
            }
        });
    }
});

buttons.forEach(btn=>{

btn.onclick=()=>{

const mode=btn.dataset.mode;

chrome.storage.local.set({dp_mode:mode});

buttons.forEach(b=>b.classList.remove("active"));
btn.classList.add("active");

// Send dynamic update to the current tab
chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if(tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {action: "updateMode", mode: mode}).catch(() => {});
    }
});

};

});

if(toggleBtn) {
    toggleBtn.addEventListener("change", (e) => {
        const isEnabled = e.target.checked;
        chrome.storage.local.set({ dp_enabled: isEnabled });
        
        // Send dynamic toggle message to current tab
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if(tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {action: "toggleFeature", enabled: isEnabled}).catch(() => {});
            }
        });
    });
}

if(siteToggleBtn) {
    siteToggleBtn.addEventListener("change", (e) => {
        if(!currentHostname) return;
        const isDisabledForSite = e.target.checked;
        
        chrome.storage.local.get(["disabled_sites"], res => {
            let disabledSites = res.disabled_sites || [];
            
            if(isDisabledForSite && !disabledSites.includes(currentHostname)) {
                disabledSites.push(currentHostname);
            } else if (!isDisabledForSite) {
                disabledSites = disabledSites.filter(h => h !== currentHostname);
            }
            
            chrome.storage.local.set({ disabled_sites: disabledSites });
            
            // Send dynamic toggle message to current tab
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if(tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {action: "toggleSite", disabledForSite: isDisabledForSite}).catch(() => {});
                }
            });
        });
    });
}

// Listen for live updates from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "updateCount") {
        if (msg.textualCount !== undefined) {
            const textCountEl = document.getElementById("text-count");
            if (textCountEl) textCountEl.innerText = msg.textualCount;
        }
        if (msg.visualCount !== undefined) {
            const visCountEl = document.getElementById("visual-count");
            if (visCountEl) visCountEl.innerText = msg.visualCount;
        }
    }
});