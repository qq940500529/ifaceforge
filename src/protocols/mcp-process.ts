import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
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
using System.Runtime.InteropServices;
using System.Text;

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
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended value, int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr GetStdHandle(int stream);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr attributes,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo child);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

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

    static IntPtr InheritStream(int stream) {
        IntPtr handle = GetStdHandle(stream);
        if (!SetHandleInformation(handle, 1, 1)) throw new Win32Exception();
        return handle;
    }

    static IntPtr OpenPipe(string path, uint access) {
        IntPtr handle = CreateFile(path, access, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception();
        if (!SetHandleInformation(handle, 1, 1)) throw new Win32Exception();
        return handle;
    }

    public static int Run(string command, string[] args, string directory, string input, string output) {
        var startup = new StartupInfo {
            Size = Marshal.SizeOf(typeof(StartupInfo)),
            Flags = 0x100, // STARTF_USESTDHANDLES
            Input = String.IsNullOrEmpty(input) ? InheritStream(-10) : OpenPipe(input, 0x80000000),
            Output = String.IsNullOrEmpty(output) ? InheritStream(-11) : OpenPipe(output, 0x40000000),
            Error = InheritStream(-12)
        };
        var commandLine = new StringBuilder(Quote(command) + " " + String.Join(" ", Array.ConvertAll(args, Quote)));
        ProcessInfo child;
        const uint noWindow = 0x08000000;
        if (!CreateProcess(command, commandLine, IntPtr.Zero, IntPtr.Zero, true, noWindow,
            IntPtr.Zero, directory, ref startup, out child)) throw new Win32Exception();
        if (!String.IsNullOrEmpty(input)) CloseHandle(startup.Input);
        if (!String.IsNullOrEmpty(output)) CloseHandle(startup.Output);
        CloseHandle(child.Thread);
        try {
            uint exitCode;
            if (WaitForSingleObject(child.Process, 0xffffffff) != 0 || !GetExitCodeProcess(child.Process, out exitCode))
                throw new Win32Exception();
            return unchecked((int)exitCode);
        } finally {
            CloseHandle(child.Process);
        }
    }
}
'@
[IfgJob]::Contain()
exit [IfgJob]::Run($launch.command, [string[]]@($launch.args), $launch.cwd, $launch.pipes.input, $launch.pipes.output)
`;

export function windowsPowerShell() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

type WindowsPipes = { input: string; output: string };

function launchPipe(path: string, receive: (socket: Socket) => void, onError: (error: Error) => void) {
  let socket: Socket | undefined;
  let rejectConnection: (error: Error) => void;
  const server = createServer((connected) => {
    if (socket) {
      connected.destroy();
      return;
    }
    socket = connected;
    socket.on('error', onError);
    receive(socket);
    deliver(socket);
    server.close();
  });
  let deliver: (socket: Socket) => void;
  const connection = new Promise<Socket>((resolve, reject) => {
    deliver = resolve;
    rejectConnection = reject;
  });
  void connection.catch(() => undefined);
  const ready = new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen({ path, readableAll: false, writableAll: false }, resolve);
  });
  return {
    ready,
    connection,
    end: () => socket?.end(),
    close() {
      rejectConnection(new Error('MCP process connection closed'));
      server.close();
      socket?.destroy();
    },
  };
}

export function startMcpProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  pipes?: WindowsPipes,
) {
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
    { ...options, env: { ...env, IFG_MCP_LAUNCH: JSON.stringify({ command, args, cwd, pipes }) } },
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
  private pipes?: { input: ReturnType<typeof launchPipe>; output: ReturnType<typeof launchPipe> };

  constructor(
    private readonly startProcess: (pipes?: WindowsPipes) => ChildProcessWithoutNullStreams,
    private readonly stderr: (chunk: Buffer) => void,
  ) {}

  async start() {
    const read = (chunk: Buffer) => {
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
    };
    let paths: WindowsPipes | undefined;
    if (process.platform === 'win32') {
      const name = '\\\\.\\pipe\\ifaceforge-mcp-' + randomUUID();
      paths = { input: name + '-in', output: name + '-out' };
      const onError = (error: Error) => this.onerror?.(error);
      this.pipes = {
        input: launchPipe(paths.input, () => undefined, onError),
        output: launchPipe(paths.output, (socket) => socket.on('data', read), onError),
      };
      await Promise.all([this.pipes.input.ready, this.pipes.output.ready]);
      if (this.closed) throw new Error('MCP process connection closed');
    }
    const child = this.startProcess(paths);
    this.child = child;
    child.stderr.on('data', this.stderr);
    child.stdout.on('data', paths ? () => undefined : read);
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.on('error', (error) => this.onerror?.(error));
    child.once('close', () => this.notifyClose());
    await once(child, 'spawn');
  }

  private notifyClose() {
    if (this.closed) return;
    this.closed = true;
    this.pipes?.input.close();
    this.pipes?.output.close();
    this.onclose?.();
  }

  close() {
    return (this.stopped ??= (async () => {
      try {
        this.pipes?.input.end();
        if (this.child) await stopMcpProcess(this.child);
      } finally {
        this.notifyClose();
      }
    })());
  }

  async send(message: JSONRPCMessage) {
    const stdin = this.pipes ? await this.pipes.input.connection : this.child?.stdin;
    if (!stdin?.writable) throw new Error('MCP process connection closed');
    await new Promise<void>((resolve, reject) =>
      stdin.write(JSON.stringify(message) + '\n', (error) => (error ? reject(error) : resolve())),
    );
  }
}
