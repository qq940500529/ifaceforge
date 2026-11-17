import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

// The supervisor joins the job before starting any repository code. Its job handle
// is non-inheritable, so terminating the supervisor also terminates descendants.
const windowsSupervisor = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$launch = ConvertFrom-Json $env:IFG_MCP_LAUNCH
Remove-Item Env:IFG_MCP_LAUNCH
Remove-Item Env:IFG_MCP_SUPERVISOR_PID -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class IfgJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Basic {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Io {
        public ulong Reads, Writes, Others, ReadBytes, WrittenBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Extended {
        public Basic Basic;
        public Io Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended value, int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);

    public static void Contain() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new Extended();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)) &&
            AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) return;
        int error = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new Win32Exception(error);
    }

    static string Quote(string value) {
        var result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? 2 * slashes + 1 : slashes);
            result.Append(ch);
            slashes = 0;
        }
        return result.Append('\\', 2 * slashes).Append('"').ToString();
    }

    static Thread Pipe(Stream input, Stream output, Action onClose) {
        // All three standard streams may use synchronous Windows handles.
        var thread = new Thread(() => {
            try {
                byte[] buffer = new byte[4096];
                int length;
                while ((length = input.Read(buffer, 0, buffer.Length)) != 0) {
                    output.Write(buffer, 0, length);
                    output.Flush();
                }
            } catch (IOException) {
                // A pipe can close while its peer is exiting.
            } catch (ObjectDisposedException) {
            } finally {
                if (onClose != null) onClose();
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    public static int Run(string command, string[] args, string directory) {
        var start = new ProcessStartInfo(command, String.Join(" ", Array.ConvertAll(args, Quote)));
        start.WorkingDirectory = directory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
        using (var child = Process.Start(start)) {
            var stdout = Pipe(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), null);
            var stderr = Pipe(child.StandardError.BaseStream, Console.OpenStandardError(), null);
            Pipe(Console.OpenStandardInput(), child.StandardInput.BaseStream, () => {
                try {
                    child.StandardInput.Close();
                    if (!child.WaitForExit(400)) Environment.Exit(0);
                } catch (InvalidOperationException) {}
            });
            child.WaitForExit();
            stdout.Join(250);
            stderr.Join(250);
            return child.ExitCode;
        }
    }
}
'@
[IfgJob]::Contain()
exit [IfgJob]::Run($launch.command, [string[]]@($launch.args), $launch.cwd)
`;

export function windowsPowerShell() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function startMcpProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const options = {
    cwd,
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: 'pipe',
  } as const;
  if (process.platform !== 'win32') return spawn(command, args, options);
  return spawn(
    windowsPowerShell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(windowsSupervisor, 'utf16le').toString('base64'),
    ],
    { ...options, env: { ...env, IFG_MCP_LAUNCH: JSON.stringify({ command, args, cwd }) } },
  );
}

export async function stopMcpProcess(child: ChildProcessWithoutNullStreams) {
  const exited =
    child.exitCode !== null || child.signalCode !== null || !child.pid
      ? Promise.resolve()
      : once(child, 'exit').catch(() => undefined);
  child.stdin.end();
  await Promise.race([exited, delay(300)]);
  if (process.platform !== 'win32' && child.pid) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-child.pid, signal);
        await delay(100);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        break;
      }
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
  await Promise.race([exited, delay(1500)]);
  child.stdout.destroy();
  child.stderr.destroy();
  if (child.pid && child.exitCode === null && child.signalCode === null)
    throw new Error('Could not verify MCP supervisor exit');
}

export class ManagedMcpStdio implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private stopped?: Promise<void>;
  private closed = false;
  get exitCode() {
    return this.child?.exitCode;
  }
  private pending = '';
  private readonly utf8 = new StringDecoder('utf8');

  constructor(
    private readonly startProcess: () => ChildProcessWithoutNullStreams,
    private readonly stderr: (chunk: Buffer) => void,
  ) {}

  async start() {
    const child = this.startProcess();
    this.child = child;
    child.stderr.on('data', this.stderr);
    child.stdout.on('data', (chunk: Buffer) => {
      this.pending += this.utf8.write(chunk);
      if (this.pending.length > 2 * 1024 * 1024) {
        this.onerror?.(Error('MCP stdout message exceeds 2 MiB'));
        void this.close().catch(() => undefined);
        return;
      }
      const lines = this.pending.split('\n');
      this.pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as JSONRPCMessage;
          if (message?.jsonrpc !== '2.0') throw Error('Invalid MCP JSON-RPC message');
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error as Error);
        }
      }
    });
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.on('error', (error) => this.onerror?.(error));
    child.once('close', () => this.notifyClose());
    await once(child, 'spawn');
  }

  private notifyClose() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  close() {
    return (this.stopped ??= (async () => {
      try {
        if (this.child) await stopMcpProcess(this.child);
      } finally {
        this.notifyClose();
      }
    })());
  }

  async send(message: JSONRPCMessage) {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error('MCP process connection closed');
    await new Promise<void>((resolve, reject) =>
      stdin.write(JSON.stringify(message) + '\n', (error) => (error ? reject(error) : resolve())),
    );
  }
}
