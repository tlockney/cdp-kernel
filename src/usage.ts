// usage_request (#409): the kernel's memory and CPU, and the host's, in
// the shape ipykernel replies with. Cells run in the target, a separate
// process, so the kernel's figures are the host process's plus the
// target's. A field this platform or target can't measure is left out.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import type { JsonObject } from "./message.ts";
import type { KernelTarget, TargetUsage } from "./target-api.ts";

/** A process's resident memory in bytes and its CPU time so far in µs, from the OS. */
export interface ProcessUsage {
  memory?: number;
  cpuTime?: number;
}

/**
 * Linux reports CPU times in clock ticks of USER_HZ, which the kernel's
 * ABI fixes at 100 on the architectures Node and Deno run on.
 */
const USER_HZ = 100;

/** How long `ps` may take: Ganymede waits 2 s for a first usage_reply (tlockney/ganymede#364). */
const PS_TIMEOUT_MS = 1_000;

/** A process's usage on Linux (/proc) or macOS (`ps`); empty elsewhere or if it can't be read. */
export async function processUsage(pid: number): Promise<ProcessUsage> {
  try {
    if (process.platform === "linux") return await procUsage(pid);
    if (process.platform === "darwin") return await psUsage(pid);
  } catch {
    // Gone, or not ours to read.
  }
  return {};
}

async function procUsage(pid: number): Promise<ProcessUsage> {
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  const usage: ProcessUsage = {};
  // Fields after the command name, which may itself hold spaces and ")":
  // the third field (state) is fields[0], so utime and stime (14, 15) are 11, 12.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  if (Number.isFinite(ticks)) usage.cpuTime = ticks * (1_000_000 / USER_HZ);
  const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (rss !== null) usage.memory = Number(rss[1]) * 1024;
  return usage;
}

async function psUsage(pid: number): Promise<ProcessUsage> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["-o", "rss=,time=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
  const [rss, time] = out.trim().split(/\s+/);
  const usage: ProcessUsage = {};
  if (rss !== undefined && /^\d+$/.test(rss)) usage.memory = Number(rss) * 1024;
  const seconds = time === undefined ? null : parseCpuTime(time);
  if (seconds !== null) usage.cpuTime = Math.round(seconds * 1_000_000);
  return usage;
}

/**
 * Several processes' usage added up, for a target that runs in more than
 * one (Miniflare's workerd). A figure any of them can't report is left out.
 */
export async function processesUsage(pids: readonly number[]): Promise<ProcessUsage> {
  const each = await Promise.all(pids.map((pid) => processUsage(pid)));
  const sum = (key: keyof ProcessUsage) =>
    each.length > 0 && each.every((u) => u[key] !== undefined) ? each.reduce((n, u) => n + u[key]!, 0) : undefined;
  const usage: ProcessUsage = {};
  const memory = sum("memory");
  const cpuTime = sum("cpuTime");
  if (memory !== undefined) usage.memory = memory;
  if (cpuTime !== undefined) usage.cpuTime = cpuTime;
  return usage;
}

/** `ps`'s `time`: [[dd-]hh:]mm:ss[.cc], in seconds; null if it isn't one. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** All CPUs' idle and total time so far, in ms; null if the OS lists none. */
function hostCpuTimes(): { idle: number; total: number } | null {
  const cpus = os.cpus();
  if (cpus.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** psutil.virtual_memory()'s fields that can be read here. */
async function hostMemory(): Promise<JsonObject> {
  const total = os.totalmem();
  const memory: JsonObject = { total };
  if (process.platform === "linux") {
    try {
      // MemAvailable is what psutil reports as available; os.freemem()
      // reads the same field, so it is read here alongside MemFree.
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const kib = (name: string) => {
        const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo);
        return match === null ? undefined : Number(match[1]) * 1024;
      };
      const available = kib("MemAvailable");
      const free = kib("MemFree");
      if (available !== undefined) {
        memory.available = available;
        memory.percent = Math.round((total - available) / total * 1000) / 10;
      }
      if (free !== undefined) memory.free = free;
    } catch {
      // No /proc: total alone.
    }
  } else {
    // macOS's free pages; psutil's "available" also counts inactive ones,
    // which Node doesn't report, so that is left out.
    memory.free = os.freemem();
  }
  return memory;
}

/**
 * Builds usage_reply content. CPU percentages cover the time since the
 * previous request: since the process started, for the first one.
 */
export class UsageMeter {
  /** The host process's CPU time when last asked, and when that was (ms). */
  #host = { cpuTime: 0, at: Date.now() - process.uptime() * 1000 };
  /** The target's CPU time when last measured, keyed by when it started (not the target, which may be gone). */
  #target: { startedAt: number | undefined; cpuTime: number; at: number } | null = null;
  #hostCpu = hostCpuTimes();

  /** `target` is the running target, or null while none runs. */
  async reply(target: KernelTarget | null): Promise<JsonObject> {
    const [targetUsage, virtualMemory] = await Promise.all([
      target?.usage ? target.usage().catch((): TargetUsage => ({})) : null,
      hostMemory(),
    ]);
    const now = Date.now();
    const content: JsonObject = { hostname: os.hostname(), pid: process.pid };

    // The host process, then the target's process: no target running
    // means the kernel is only the host. A target that can't be measured
    // leaves the figure out rather than reporting the host's alone.
    const { user, system } = process.cpuUsage();
    const hostCpu = user + system;
    let cpu: number | null = percentOf(hostCpu - this.#host.cpuTime, now - this.#host.at);
    this.#host = { cpuTime: hostCpu, at: now };
    let memory: number | null = process.memoryUsage().rss;
    if (target !== null) {
      if (targetUsage?.cpuTime === undefined) {
        // The previous sample stays the baseline, so one missed sample
        // doesn't make the next reply average over the target's life.
        cpu = null;
      } else {
        const { startedAt } = targetUsage;
        const last = startedAt !== undefined && this.#target?.startedAt === startedAt
          ? this.#target
          : { cpuTime: 0, at: startedAt ?? now };
        cpu += percentOf(targetUsage.cpuTime - last.cpuTime, now - last.at);
        this.#target = { startedAt, cpuTime: targetUsage.cpuTime, at: now };
      }
      memory = targetUsage?.memory === undefined ? null : memory + targetUsage.memory;
    }
    if (cpu !== null) content.kernel_cpu = Math.round(cpu * 10) / 10;
    if (memory !== null) content.kernel_memory = memory;

    const times = hostCpuTimes();
    if (times !== null && this.#hostCpu !== null) {
      const total = times.total - this.#hostCpu.total;
      if (total > 0) content.host_cpu_percent = Math.round((1 - (times.idle - this.#hostCpu.idle) / total) * 1000) / 10;
    }
    this.#hostCpu = times;
    const cpuCount = os.cpus().length;
    if (cpuCount > 0) content.cpu_count = cpuCount;
    content.host_virtual_memory = virtualMemory;
    return content;
  }
}

/** CPU time (µs) over wall time (ms), as a percentage of one CPU. */
function percentOf(cpuMicros: number, wallMs: number): number {
  return wallMs > 0 ? Math.max(0, cpuMicros / (wallMs * 1000) * 100) : 0;
}
