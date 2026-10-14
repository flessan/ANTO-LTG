// A deliberately tiny DOM stand-in so assets/js/lib/html.js (h(), clear(), replaceChildren()) can be unit
// tested in Node without adding jsdom as a dependency. It implements only what html.js touches. Real-DOM
// behaviour is covered by tests/e2e (headless Chrome), so this file never has to be a faithful DOM.

class FakeNode {}

class FakeText extends FakeNode {
  constructor(text) { super(); this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.listeners = [];
    this.dataset = {};
    this.className = '';
    this.styleProps = new Map();
    this.style = { setProperty: (name, value) => this.styleProps.set(name, value) };
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  append(...nodes) { for (const n of nodes) this.childNodes.push(n); }
  get firstChild() { return this.childNodes[0] ?? null; }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); return child; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  /** All descendant elements, depth first. */
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}

export function installFakeDom() {
  const previous = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
  };
  return () => { globalThis.document = previous.document; globalThis.Node = previous.Node; };
}

export { FakeElement, FakeText };
