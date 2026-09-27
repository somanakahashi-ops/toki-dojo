// 短い知らせ（画面の上）。最大3件・4秒で消える。
import { el } from "./dom.js";

export class Toasts {
  constructor(root) {
    this.box = el("div", { class: "toasts", attrs: { role: "status" } });
    root.append(this.box);
  }

  show(type, message) {
    const t = el("div", { class: `toast ${type}`, text: message });
    this.box.prepend(t);
    while (this.box.children.length > 3) this.box.lastChild.remove();
    setTimeout(() => t.remove(), 4000);
  }
}
