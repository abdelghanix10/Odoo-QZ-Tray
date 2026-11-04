# Odoo QZ Tray Integration (`odoo_qz_print`)

![Odoo Version](https://img.shields.io/badge/Odoo-19.0%20%7C%2020.0-875A7B.svg)
![QZ Tray](https://img.shields.io/badge/QZ%20Tray-2.2.5-green.svg)
![License](https://img.shields.io/badge/License-LGPL--3-blue.svg)

Direct, silent hardware printing integration between **Odoo 19 / Odoo 20** (Backend & Point of Sale) and **QZ Tray**.

This module eliminates browser print dialogs in Odoo POS, supports offline receipt signing, and includes a resilient connection manager with automatic recovery and HTTP/LAN support.

---

## ✨ Key Features

- **Silent POS Receipt Printing**: Patches `PosStore.prototype.printReceipt` to print POS receipts directly to the default printer via QZ Tray when `receipt_print_method` is set to `'qz_tray'`.
- **Backend Test Print Button**: Adds a systray print icon in the Odoo backend to quickly verify QZ Tray connectivity and printer setup.
- **3-Tier Hybrid Request Signing (HTTPS, HTTP LAN & Offline Ready)**:
  1. **Web Crypto API (`window.crypto.subtle`)**: Fast local client-side signing on `https://` and `http://localhost`.
  2. **Pure-JS RSA-SHA1 (`BigInt`) Fallback**: Local client-side signing on plain HTTP LAN addresses (e.g., `http://192.168.1.x:8069`) where browsers disable `window.crypto.subtle`.
  3. **Server-Side Fallback (`/qz/sign`)**: Automatic server fallback if client-side key import is unavailable.
- **Connection Resilience**:
  - Coalesced WebSocket reconnection on port `8181`.
  - 60-second active heartbeat probes.
  - Automatic recovery on browser `focus`, `visibilitychange`, and `online` events.
- **Offline-Safe POS Service Worker**: Overrides `/pos/service-worker.js` to prevent unhandled promise rejections when the POS terminal goes offline.

---

## 📁 Module Structure

```text
odoo_qz_print/
├── __init__.py
├── __manifest__.py
├── README.md
├── generate_keys.py                  # Script to generate RSA-2048 key & X.509 certificate
├── keys/                             # Generated keys (git-ignored)
│   ├── digital-certificate.txt
│   └── private-key.pem
├── controllers/
│   ├── __init__.py
│   └── main.py                       # /qz/certificate, /qz/private_key, /qz/sign & SW route
└── static/
    ├── lib/
    │   └── qz-tray.js                # QZ Tray JS Connector v2.2.5
    └── src/
        ├── qz_service.js             # Odoo QZ Tray service (connection, signing, print retry)
        ├── pos_qz_patch.js           # PosStore.printReceipt patch
        ├── print_icon.js             # Backend Systray test component
        ├── print_icon.xml            # Backend Systray template
        └── service_worker.js         # Resilient POS Service Worker
```

---

## 🛠 Prerequisites

1. **Python Dependency** (on the Odoo server):
   ```bash
   pip install cryptography
   ```
2. **QZ Tray Client** (on each POS / client machine):
   - Download and install **QZ Tray 2.2.x** from [https://qz.io/download/](https://qz.io/download/).
   - Ensure a default printer is configured in the operating system.

---

## 🚀 Installation & Setup

### Step 1: Clone or Copy the Module
Place the `odoo_qz_print` folder inside your Odoo `custom-addons` directory.

### Step 2: Generate the Certificate and Private Key
Run the key generator script once on the Odoo server:

```bash
cd /path/to/custom-addons/odoo_qz_print
python3 generate_keys.py
```

This creates two files inside `odoo_qz_print/keys/`:
- `private-key.pem` (RSA 2048-bit private key — kept private, excluded via `.gitignore`)
- `digital-certificate.txt` (Public X.509 certificate valid for 10 years)

### Step 3: Trust the Certificate in QZ Tray (Client PC)
Copy `keys/digital-certificate.txt` to the client PC running QZ Tray and import it so QZ Tray trusts silent print requests without showing popups:

1. Right-click the **QZ Tray** icon in the system tray.
2. Open **Advanced** → **Site Manager**.
3. Click the **`+`** button → **Browse...** and select `digital-certificate.txt`.
4. Alternatively, when prompted by QZ Tray on the first print request, check **"Remember this decision"** and click **Allow**.

### Step 4: Install the Module in Odoo
1. Restart the Odoo server.
2. Enable **Developer Mode** in Odoo.
3. Go to **Apps** → **Update Apps List**.
4. Search for **`odoo_qz_print`** and click **Install**.

---

## 🔄 Odoo 19 vs. Odoo 20 Compatibility

This addon supports both **Odoo 19** and **Odoo 20**. If you are switching between versions, note the following differences:

| Component | Odoo 19 | Odoo 20 |
| :--- | :--- | :--- |
| **`__manifest__.py` Version** | `'version': '19.0.1.0.0'` (or `'1.0'`) | **`'version': '20.0.1.0.0'`** *(Required prefix in Odoo 20)* |
| **Systray Icon (`print_icon.xml`)** | Font Awesome (`<i class="fa fa-print fa-lg"/>`) | Material Symbols (`<i class="oi oi-fw" data-icon="print"/>`) |
| **Template Event Handler** | `t-on-click="onClick"` or `t-on-click="this.onClick"` | **`t-on-click="this.onClick"`** *(OWL 3 strict syntax)* |
| **Service Access in `PosStore`** | `this.env.services.qz_tray` / `this.env.services.renderer` | `getQzService()` & `this.renderer \|\| this.env?.services?.renderer` |
| **Python Version** | Python 3.10 – 3.12 | Python 3.12 – 3.14 (`datetime.now(timezone.utc)`) |

> **Tip for Odoo 19 Users:**  
> If running on **Odoo 19**, set `'version': '19.0.1.0.0'` in `__manifest__.py`. For the systray icon in `static/src/print_icon.xml`, you can use `<i class="fa fa-print fa-lg oi oi-fw" data-icon="print" .../>` so the icon renders in both Odoo 19 (Font Awesome) and Odoo 20 (`.oi` ligatures).

---

## 🖨 Usage

### 1. Testing in the Odoo Backend
- Look at the top-right **Systray** bar in the Odoo backend.
- Click the **Print Icon**.
- A test page (`Odoo QZ Test` with the current timestamp) will be sent directly to your OS default printer.

### 2. Printing Receipts in Point of Sale (POS)
- In `PosStore`, when `this.config.receipt_print_method === "qz_tray"`, `printReceipt()` automatically routes the rendered `OrderReceipt` HTML through `qz_tray.print(printerName, htmlContent, "pixel", {})`.
- You can also call the service from any custom OWL component or POS screen:
  ```javascript
  import { useService } from "@web/core/utils/hooks";

  setup() {
      this.qz = useService("qz_tray");
  }

  async printCustomLabel(htmlString) {
      const printer = await this.qz.getDefaultPrinter();
      await this.qz.print(printer, htmlString, "pixel", { scaleContent: false });
  }
  ```

---

## 🔒 Security & HTTP Endpoints

| Route | Auth | Method | Description |
| :--- | :--- | :--- | :--- |
| `/qz/certificate` | `public` | `GET` | Returns the public X.509 PEM certificate (`digital-certificate.txt`). |
| `/qz/private_key` | `user` | `GET` | Returns the PKCS#8 PEM private key to authenticated Odoo users for local browser signing. |
| `/qz/sign` | `public` | `GET`, `POST` | Fallback server-side SHA-1 PKCS#1 v1.5 signing endpoint. |
| `/pos/service-worker.js` | `user` | `GET` | Serves the offline-resilient POS Service Worker. |

---

## 🛠 Troubleshooting

### 1. `window.crypto.subtle is undefined` on LAN IP (`http://192.168.x.x`)
- **Cause**: Browsers disable `window.crypto.subtle` on non-HTTPS origins (except `localhost`).
- **Resolution**: Handled automatically by `qz_service.js` using the built-in pure-JS `BigInt` RSA-SHA1 fallback. Make sure your browser cache and POS Service Worker are updated after upgrading the module.

### 2. Changes Not Reflecting in POS After Module Upgrade
Because Odoo POS uses a Service Worker that caches asset bundles (`point_of_sale.assets_prod.min.js`):
1. Open Browser DevTools (`F12`) on the POS screen.
2. Go to **Application** (Chrome/Edge) or **Storage** (Firefox) → **Service Workers**.
3. Click **Unregister** next to `/pos/service-worker.js`.
4. Hard-reload the page (`Ctrl + Shift + R`).

### 3. `QZ websocket connect timed out`
- Verify that the **QZ Tray** application is running in the client's system tray.
- Ensure port `8181` (`wss://localhost:8181`) is not blocked by local antivirus or firewall software.

---

## 📄 License
This module is licensed under the **LGPL-3.0** License.