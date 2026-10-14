const g = Object.getOwnPropertyDescriptor(globalThis, "Deno");
console.log("globalThis.Deno", { configurable: g.configurable, writable: g.writable, enumerable: g.enumerable });
const real = globalThis.Deno;
const ns = { display() {} };
const proxy = new Proxy(real, { get: (t, k) => (k === "jupyter" ? ns : Reflect.get(t, k, t)) });
Object.defineProperty(globalThis, "Deno", { ...g, value: proxy });
console.log("alias works:", Deno.jupyter === ns, "readTextFile ok:", typeof Deno.readTextFileSync("/etc/hosts"));
const m = await import(process.argv[2] ?? "npm:is-odd@3.0.1");
console.log("npm import ok", m.default(3));
