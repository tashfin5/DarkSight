

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchLLM") {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout

        fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "mistral",
                prompt: request.prompt,
                stream: false
            }),
            signal: controller.signal
        })
        .then(async res => {
            clearTimeout(timeoutId);
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            if (!text) {
                throw new Error("Empty response from Ollama (possibly overloaded)");
            }
            return JSON.parse(text);
        })
        .then(data => sendResponse({ success: true, data: data }))
        .catch(err => {
            clearTimeout(timeoutId);
            console.error("Background fetch error:", err);
            sendResponse({ success: false, error: err.name === 'AbortError' ? 'Ollama request timed out (25s)' : err.message });
        });
        
        return true; // Keep the message channel open for the async response
    }
});
