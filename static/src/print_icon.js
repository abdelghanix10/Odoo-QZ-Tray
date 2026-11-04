/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class QzPrintIcon extends Component {
  static template = "odoo_qz_print.QzPrintIcon";
  static props = {};

  setup() {
    this.qz = useService("qz_tray");
  }

  async onClick() {
    try {
      // 1. Connect to QZ Tray first
      await this.qz.connect();

      // 2. Get the QZ library and find default printer
      const qzLib = this.qz.getQZ();
      if (!qzLib) {
        throw new Error("QZ Tray library not available. Is QZ Tray running?");
      }

      const defaultPrinter = await qzLib.printers.getDefault();

      // 3. Define simple HTML content to print
      const htmlContent = `
        <html>
        <body>
            <h1>Odoo 20 QZ Test</h1>
            <p>If you can read this, QZ Tray is working!</p>
            <hr/>
            <p>Time: ${new Date().toLocaleString()}</p>
        </body>
        </html>
      `;

      // 4. Send to printer
      await this.qz.print(defaultPrinter, htmlContent, "pixel");
    } catch (error) {
      console.error("[QZ] Test print failed:", error);
    }
  }
}

export const systrayItem = {
  Component: QzPrintIcon,
};

registry
  .category("systray")
  .add("qz_print_icon", systrayItem, { sequence: 100 });
