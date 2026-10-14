// Which FFI surfaces exist in each runtime? Loads libc and calls getpid().
const libc = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : typeof Deno !== "undefined" ? `deno ${Deno.version.deno}` : `node ${process.versions.node}`;
try {
  if (typeof Bun !== "undefined") {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen(libc, { getpid: { args: [], returns: FFIType.i32 } });
    console.log(runtime, "bun:ffi getpid =", lib.symbols.getpid(), "pid", process.pid);
  } else if (typeof Deno !== "undefined") {
    const lib = Deno.dlopen(libc, { getpid: { parameters: [], result: "i32" } });
    console.log(runtime, "Deno.dlopen getpid =", lib.symbols.getpid(), "pid", Deno.pid);
  } else {
    const ffi = await import("node:ffi");
    console.log(runtime, "node:ffi exports:", Object.keys(ffi).join(", "));
    const { lib, functions } = ffi.dlopen(libc, { getpid: { arguments: [], return: "i32" } });
    console.log(runtime, "node:ffi getpid =", functions.getpid(), "pid", process.pid);
    lib.close?.();
  }
} catch (err) {
  console.log(runtime, "FFI unavailable:", err.code ?? "", err.message.split("\n")[0]);
}
