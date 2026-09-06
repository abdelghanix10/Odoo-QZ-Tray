// @odoo-module ignore
/* eslint-disable no-restricted-globals */
/* eslint-disable no-undef */

const cacheName = "odoo-pos-cache";

const fetchCacheRespond = async (event) => {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(event.request);
        // Safe caching: Only cache successful responses and catch any caching error
        if (response && response.ok) {
            try {
                await cache.put(event.request, response.clone());
            } catch {
                // Ignore cache put errors (e.g. non-cacheable headers, quota limits)
            }
        }
        return response;
    } catch {
        // Fallback to cache if network fails
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
            return cachedResponse;
        }
        // Never return undefined to event.respondWith()
        // Returning a valid 503 Response prevents:
        // "TypeError: Failed to convert value to 'Response'"
        return new Response("Network error or offline", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "Content-Type": "text/plain" },
        });
    }
};

const cacheResources = async (event) => {
    const url = event.request.url;

    try {
        const cache = await caches.open(cacheName);
        await cache.add(url);
    } catch (error) {
        console.info("Failed to cache resource", url, error);
    }
};

self.addEventListener("fetch", (event) => {
    const url = event.request.url;

    // Ignore Chrome extensions, dataset, QZ Tray endpoints, and non-GET requests
    if (
        url.includes("extension") ||
        url.includes("web/dataset") ||
        url.includes("hw_proxy/hello") ||
        url.includes("Cashdro3WS/index3.php") ||
        url.includes("/qz/") ||
        event.request.method !== "GET"
    ) {
        return;
    }

    event.respondWith(fetchCacheRespond(event));
});

// Handle notification
self.addEventListener("message", (event) => {
    const data = event.data;
    if (data.urlsToCache && navigator.onLine) {
        for (const url of data.urlsToCache) {
            cacheResources({ request: { url } });
        }
    }
});
