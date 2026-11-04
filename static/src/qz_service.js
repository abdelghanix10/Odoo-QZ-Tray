/** @odoo-module **/

import { registry } from "@web/core/registry";

const CONNECT_TIMEOUT_MS = 5000;
const PRINT_TIMEOUT_MS = 10000;
const PRINTER_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 60000;
const LOG_PREFIX = "[QZ]";

function ts() {
  return new Date().toISOString().substring(11, 23);
}

function log(...args) {
  console.log(LOG_PREFIX, `[${ts()}]`, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, `[${ts()}]`, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, `[${ts()}]`, ...args);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// --- Pure-JS RSA-SHA1 (PKCS#1 v1.5) fallback for HTTP (non-secure contexts) ---

function sha1Bytes(bytes) {
  const ml = bytes.length;
  const withOne = ml + 1;
  const padLen = (64 - ((withOne + 8) % 64)) % 64;
  const totalLen = withOne + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[ml] = 0x80;

  const view = new DataView(buf.buffer);
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rol = (n, b) => ((n << b) | (n >>> (32 - b))) >>> 0;

  for (let i = 0; i < totalLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 80; j++) {
      w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    }

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;

    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rol(a, 5) + (f >>> 0) + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

function readAsn1Element(buf, offset) {
  const tag = buf[offset++];
  let len = buf[offset++];
  if (len & 0x80) {
    const numBytes = len & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) {
      len = (len << 8) | buf[offset++];
    }
  }
  return { tag, headerEnd: offset, end: offset + len, len };
}

function bytesToBigInt(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt("0x" + (hex || "0"));
}

function parsePkcs8RsaKey(pkcs8Bytes) {
  const seq = readAsn1Element(pkcs8Bytes, 0);
  if (seq.tag !== 0x30) throw new Error("Invalid PKCS#8 SEQUENCE");
  const ver = readAsn1Element(pkcs8Bytes, seq.headerEnd);
  const alg = readAsn1Element(pkcs8Bytes, ver.end);
  const privOctet = readAsn1Element(pkcs8Bytes, alg.end);
  if (privOctet.tag !== 0x04) throw new Error("Invalid PKCS#8 OCTET STRING");

  const rsaSeq = readAsn1Element(pkcs8Bytes, privOctet.headerEnd);
  if (rsaSeq.tag !== 0x30) throw new Error("Invalid RSAPrivateKey SEQUENCE");
  const rsaVer = readAsn1Element(pkcs8Bytes, rsaSeq.headerEnd);
  const modElem = readAsn1Element(pkcs8Bytes, rsaVer.end);
  const pubExpElem = readAsn1Element(pkcs8Bytes, modElem.end);
  const privExpElem = readAsn1Element(pkcs8Bytes, pubExpElem.end);

  let modBytes = pkcs8Bytes.subarray(modElem.headerEnd, modElem.end);
  while (modBytes.length > 1 && modBytes[0] === 0x00) {
    modBytes = modBytes.subarray(1);
  }
  const privExpBytes = pkcs8Bytes.subarray(
    privExpElem.headerEnd,
    privExpElem.end,
  );

  return {
    n: bytesToBigInt(modBytes),
    d: bytesToBigInt(privExpBytes),
    k: modBytes.length,
  };
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function rsaSignPkcs1Sha1(dataBytes, rsaKey) {
  const digest = sha1Bytes(dataBytes);
  // ASN.1 DER DigestInfo header for SHA-1
  const digestInfoPrefix = new Uint8Array([
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05,
    0x00, 0x04, 0x14,
  ]);
  const tLen = digestInfoPrefix.length + digest.length;
  const k = rsaKey.k;
  if (k < tLen + 11) {
    throw new Error("RSA modulus too short");
  }

  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x01;
  const psLen = k - tLen - 3;
  em.fill(0xff, 2, 2 + psLen);
  em[2 + psLen] = 0x00;
  em.set(digestInfoPrefix, 3 + psLen);
  em.set(digest, 3 + psLen + digestInfoPrefix.length);

  const m = bytesToBigInt(em);
  const s = modPow(m, rsaKey.d, rsaKey.n);

  const sigHex = s.toString(16).padStart(k * 2, "0");
  const sigBytes = new Uint8Array(k);
  for (let i = 0; i < k; i++) {
    sigBytes[i] = parseInt(sigHex.substring(i * 2, i * 2 + 2), 16);
  }
  return sigBytes;
}

export const qzTrayService = {
  async start(env) {
    // --- State ---
    let securityConfigured = false;
    let cachedCert = null;
    let cachedPrivateKey = null;
    let importedKey = null;
    let fallbackRsaKey = null;
    let cachedPrinterName = null;
    let reconnectPromise = null; // coalesce concurrent reconnects
    let heartbeatTimer = null;
    let printingInProgress = false; // guard heartbeat during print
    let destroyed = false;

    const hasWebCryptoSubtle = () =>
      typeof window !== "undefined" &&
      Boolean(window.crypto && window.crypto.subtle);

    // --- Security cache initialization ---

    const initSecurityCache = async () => {
      try {
        const certRes = await fetch("/qz/certificate");
        if (certRes.ok) {
          cachedCert = await certRes.text();
        }
      } catch (e) {
        warn("Failed to pre-cache QZ certificate:", e);
      }

      try {
        const keyRes = await fetch("/qz/private_key");
        if (keyRes.ok) {
          cachedPrivateKey = await keyRes.text();
        }
      } catch (e) {
        warn("Failed to pre-cache QZ private key:", e);
      }
    };

    const securityCachePromise = initSecurityCache();

    // --- Crypto helpers ---

    const decodePkcs8Pem = (pem) => {
      const pemHeader = "-----BEGIN PRIVATE KEY-----";
      const pemFooter = "-----END PRIVATE KEY-----";
      const startIdx = pem.indexOf(pemHeader);
      const endIdx = pem.indexOf(pemFooter);
      if (startIdx === -1 || endIdx === -1) {
        throw new Error("Invalid PEM format for private key");
      }
      const pemContents = pem.substring(startIdx + pemHeader.length, endIdx);
      const base64 = pemContents.replace(/\s+/g, "");
      const binaryDerString = window.atob(base64);
      const len = binaryDerString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryDerString.charCodeAt(i);
      }
      return bytes;
    };

    const ensurePrivateKeyLoaded = async () => {
      if (!cachedPrivateKey) {
        await securityCachePromise;
      }
      if (!cachedPrivateKey) {
        try {
          const keyRes = await fetch("/qz/private_key");
          if (keyRes.ok) {
            cachedPrivateKey = await keyRes.text();
          }
        } catch {
          // Ignore network error; caller will handle null
        }
      }
      return cachedPrivateKey;
    };

    const getImportedKey = async () => {
      if (importedKey || fallbackRsaKey) {
        return { importedKey, fallbackRsaKey };
      }

      const pem = await ensurePrivateKeyLoaded();
      if (!pem) {
        return null;
      }

      try {
        const bytes = decodePkcs8Pem(pem);

        if (hasWebCryptoSubtle()) {
          importedKey = await window.crypto.subtle.importKey(
            "pkcs8",
            bytes.buffer,
            {
              name: "RSASSA-PKCS1-v1_5",
              hash: { name: "SHA-1" },
            },
            false,
            ["sign"],
          );
        } else {
          // Insecure context (HTTP over LAN IP): use pure-JS RSA key
          fallbackRsaKey = parsePkcs8RsaKey(bytes);
        }
        return { importedKey, fallbackRsaKey };
      } catch (e) {
        error("Error importing private key for client-side signing:", e);
        return null;
      }
    };

    const signMessageLocally = async (toSign) => {
      const keyBundle = await getImportedKey();
      if (!keyBundle || (!keyBundle.importedKey && !keyBundle.fallbackRsaKey)) {
        throw new Error("Private key not available for client-side signing");
      }

      const encoder = new TextEncoder();
      const data = encoder.encode(toSign);
      let signatureArray;

      if (keyBundle.importedKey && hasWebCryptoSubtle()) {
        const signatureBuffer = await window.crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          keyBundle.importedKey,
          data,
        );
        signatureArray = new Uint8Array(signatureBuffer);
      } else {
        signatureArray = rsaSignPkcs1Sha1(data, keyBundle.fallbackRsaKey);
      }

      let binary = "";
      for (let i = 0; i < signatureArray.byteLength; i++) {
        binary += String.fromCharCode(signatureArray[i]);
      }
      return window.btoa(binary);
    };

    // --- QZ accessors ---

    const getQZ = () => {
      if (typeof window !== "undefined" && window.qz) {
        return window.qz;
      }
      return null;
    };

    const waitForQZ = async (timeout = 5000) => {
      const startTime = Date.now();
      while (!getQZ() && Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return getQZ();
    };

    // --- Security configuration ---

    const configureSecurity = (qz) => {
      if (securityConfigured) {
        return;
      }

      qz.security.setCertificatePromise(function (resolve, reject) {
        securityCachePromise
          .then(() => {
            if (cachedCert) {
              return cachedCert;
            }
            return fetch("/qz/certificate").then((response) => {
              if (!response.ok) {
                throw new Error(`Certificate fetch failed: ${response.status}`);
              }
              return response.text();
            });
          })
          .then((cert) => {
            cachedCert = cert;
            resolve(cert);
          })
          .catch(reject);
      });

      qz.security.setSignaturePromise(function (toSign) {
        return function (resolve, reject) {
          signMessageLocally(toSign)
            .then(resolve)
            .catch((localSignError) => {
              warn(
                "Client-side signing failed, falling back to server:",
                localSignError,
              );
              fetch("/qz/sign", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: toSign,
              })
                .then((response) => {
                  if (!response.ok) {
                    throw new Error(`Signing failed: ${response.status}`);
                  }
                  return response.text();
                })
                .then(resolve)
                .catch(reject);
            });
        };
      });

      securityConfigured = true;
    };

    // --- Connection management ---

    const safeDisconnect = async (reason = "unspecified") => {
      const qz = getQZ();
      if (!qz) return;

      try {
        await qz.websocket.disconnect();
      } catch (e) {
        warn(
          "Disconnect error (ignored) — reason:",
          reason,
          "—",
          e.message || e,
        );
      }
    };

    const connect = async () => {
      const qz = await waitForQZ();
      if (!qz) {
        throw new Error(
          "QZ Tray library not loaded. Make sure qz-tray.js is included in assets.",
        );
      }

      configureSecurity(qz);

      try {
        await withTimeout(
          qz.websocket.connect({
            host: "localhost",
            port: {
              secure: [8181],
              insecure: [],
            },
            usingSecure: true,
            keepAlive: 60,
          }),
          CONNECT_TIMEOUT_MS,
          "QZ websocket connect",
        );
      } catch (e) {
        const msg = (e.message || String(e)).toLowerCase();
        if (
          msg.includes("already connected") ||
          msg.includes("already exists")
        ) {
          return;
        }
        warn("Connect failed, cleaning up —", e.message);
        await safeDisconnect("connect failure cleanup");
        throw e;
      }
    };

    const reconnect = async (reason = "unspecified") => {
      if (reconnectPromise) {
        return reconnectPromise;
      }

      reconnectPromise = (async () => {
        const t0 = Date.now();

        try {
          await safeDisconnect("reconnect: " + reason);
          await connect();

          if (!getQZ()?.websocket.isActive()) {
            throw new Error("Websocket still inactive after reconnect");
          }

          cachedPrinterName = null;
        } catch (e) {
          error("Reconnect failed — took", Date.now() - t0, "ms —", e.message);
          throw e;
        } finally {
          reconnectPromise = null;
        }
      })();

      return reconnectPromise;
    };

    const ensureConnected = async (reason = "unspecified") => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      if (qz.websocket.isActive()) {
        return;
      }

      await reconnect(reason);
    };

    // --- Error classification ---

    const isConnectionError = (err) => {
      const msg = ((err && err.message) || String(err)).toLowerCase();
      return (
        msg.includes("websocket closed") ||
        msg.includes("connection lost") ||
        msg.includes("already connected") ||
        msg.includes("already exists") ||
        msg.includes("connection refused") ||
        msg.includes("not connected") ||
        msg.includes("connection timed out") ||
        msg.includes("failed to connect") ||
        msg.includes("broken pipe") ||
        msg.includes("networkerror") ||
        msg.includes("aborterror")
      );
    };

    // --- Printer management ---

    const getDefaultPrinter = async () => {
      if (cachedPrinterName) {
        return cachedPrinterName;
      }

      const fetchPrinter = async () => {
        const qz = getQZ();
        return await withTimeout(
          qz.printers.getDefault(),
          PRINTER_TIMEOUT_MS,
          "getDefaultPrinter",
        );
      };

      try {
        await ensureConnected("getDefaultPrinter");
        cachedPrinterName = await fetchPrinter();
        return cachedPrinterName;
      } catch (e) {
        warn(
          "getDefaultPrinter failed, reconnecting and retrying —",
          e.message,
        );
        cachedPrinterName = null;
        await reconnect("getDefaultPrinter failure");
        cachedPrinterName = await fetchPrinter();
        return cachedPrinterName;
      }
    };

    // --- Print with retry ---

    const executePrint = async (printerName, data, type, options) => {
      const qz = getQZ();
      const config = qz.configs.create(printerName, {
        scaleContent: false,
        ...options,
      });

      const printData = [
        {
          type: type,
          format: type === "pixel" ? "html" : "command",
          flavor: type === "pixel" ? "plain" : "plain",
          data: data,
        },
      ];

      await withTimeout(
        qz.print(config, printData),
        PRINT_TIMEOUT_MS,
        "QZ print",
      );
    };

    const print = async (printerName, data, type = "pixel", options = {}) => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      const t0 = Date.now();
      printingInProgress = true;

      try {
        try {
          await ensureConnected("print:attempt1");
          await executePrint(printerName, data, type, options);
          return;
        } catch (firstErr) {
          warn("Print attempt 1 failed —", firstErr.message || firstErr);

          if (!isConnectionError(firstErr)) {
            error("Print failed (non-connection error):", firstErr);
            throw firstErr;
          }
        }

        warn("Print attempt 1 connection error — reconnecting for retry");

        try {
          await reconnect("print:retry");
          await executePrint(printerName, data, type, options);
        } catch (retryErr) {
          error(
            "Print retry failed — gave up after",
            Date.now() - t0,
            "ms —",
            retryErr,
          );
          throw retryErr;
        }
      } finally {
        printingInProgress = false;
      }
    };

    // --- Heartbeat ---

    const startHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }

      heartbeatTimer = setInterval(async () => {
        if (destroyed || printingInProgress) {
          return;
        }

        const qz = getQZ();
        if (!qz) {
          return;
        }

        if (!qz.websocket.isActive()) {
          warn("Heartbeat: websocket inactive — triggering reconnect");
          try {
            await reconnect("heartbeat:inactive");
          } catch (e) {
            error("Heartbeat reconnect failed:", e.message);
          }
          return;
        }

        try {
          await withTimeout(
            qz.printers.getDefault(),
            PRINTER_TIMEOUT_MS,
            "Heartbeat probe",
          );
        } catch (e) {
          warn(
            "Heartbeat probe failed — websocket claims active but probe failed:",
            e.message,
          );
          try {
            await reconnect("heartbeat:probe-failed");
          } catch (reconnErr) {
            error("Heartbeat reconnect failed:", reconnErr.message);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    // --- WebSocket close callback ---

    const registerCloseCallback = () => {
      const qz = getQZ();
      if (!qz?.websocket?.setClosedCallbacks) {
        return;
      }

      qz.websocket.setClosedCallbacks(function (data) {
        warn("WebSocket closed callback fired:", data);
        cachedPrinterName = null;
      });
    };

    // --- Browser lifecycle recovery ---

    const registerBrowserLifecycle = () => {
      const recover = async (event) => {
        if (destroyed) return;

        const qz = getQZ();
        if (!qz) return;

        if (qz.websocket.isActive()) {
          return;
        }

        try {
          await reconnect("lifecycle:" + event);
        } catch (e) {
          error("Lifecycle reconnect failed:", e.message);
        }
      };

      window.addEventListener("focus", () => recover("focus"));
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          recover("visibilitychange");
        }
      });
      window.addEventListener("online", () => recover("online"));
    };

    // --- Startup ---

    const qz = await waitForQZ();
    if (qz) {
      registerCloseCallback();
    }
    registerBrowserLifecycle();
    startHeartbeat();

    // --- Public API ---

    return {
      connect,
      print,
      getDefaultPrinter,
      getQZ,
    };
  },
};

registry.category("services").add("qz_tray", qzTrayService);
