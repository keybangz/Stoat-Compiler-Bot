import { Client, Message } from "stoat.js";
import * as dotenv from "dotenv";
import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, statSync, createWriteStream } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import axios from "axios";
import archiver from "archiver";
import { randomBytes } from "crypto";

dotenv.config();

// ============================================
// Constants
// ============================================

const MAX_CODE_SIZE = 100000 // 100KB max code size
const MAX_OUTPUT_SIZE = 2000 // Characters to show in output

// ============================================
// Utility Functions
// ============================================

function generateRandomId(length: number = 8): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let result = ''
    const randomValues = randomBytes(length)
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length]
    }
    return result
}

function log(...args: any[]) {
    console.log(`[${new Date().toISOString()}]`, ...args)
}

// ============================================
// Configuration
// ============================================

const BOT_TOKEN = process.env.REVOLT_TOKEN || process.env.STOAT_TOKEN;

if (!BOT_TOKEN) {
    console.error("Missing REVOLT_TOKEN or STOAT_TOKEN in .env");
    process.exit(1);
}

interface BotConfig {
    allowedChannelId: string | null;
    prefix: string;
    adminUsers: string[];
    adminRoleIds: string[];
}

const CONFIG_PATH = join(process.cwd(), "bot-config.json");
const DEFAULT_CONFIG: BotConfig = {
    allowedChannelId: null,
    prefix: "!",
    adminUsers: [],
    adminRoleIds: [],
};

function loadConfig(): BotConfig {
    try {
        if (existsSync(CONFIG_PATH)) {
            const data = readFileSync(CONFIG_PATH, "utf-8");
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
        }
    } catch {
        console.warn("Failed to load config, using defaults")
    }
    return { ...DEFAULT_CONFIG }
}

function saveConfig(cfg: BotConfig): void {
    try {
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8")
    } catch (err) {
        console.error("Failed to save config:", err)
    }
}

let config = loadConfig()

// ============================================
// Build Queue
// ============================================

type QueueTask = () => Promise<string | BuildResponse | RunResponse | null>

interface BuildResponse {
    type: 'build'
    content: string
    binaryPath: string
    binaryName: string
    targetKey: string
}

interface RunResponse {
    type: 'run'
    content: string
    output: string
    timedOut: boolean
    exitCode: number | null
}

const buildQueue: QueueTask[] = []
let isProcessing = false

async function processQueue(): Promise<void> {
    if (isProcessing || buildQueue.length === 0) return

    isProcessing = true
    const task = buildQueue.shift()!

    try {
        await task()
    } catch (err) {
        log("Queue task error:", err)
    }

    isProcessing = false
    if (buildQueue.length > 0) {
        setImmediate(() => processQueue())
    }
}

function enqueueBuild(task: QueueTask): Promise<string | BuildResponse | RunResponse | null> {
    return new Promise((resolve) => {
        buildQueue.push(async () => {
            try {
                const result = await task()
                resolve(result)
                return result
            } catch (err) {
                log("Build task error:", err)
                resolve(null)
                return null
            }
        })
        processQueue()
    })
}

// ============================================
// Build Targets
// ============================================

interface BuildTarget {
    os: "linux" | "windows"
    arch: "x64" | "arm64"
    extension: string
    compiler: string
    flags: string[]
    language: 'cpp' | 'rust'
}

const CPP_TARGETS: Record<string, BuildTarget> = {
    "cpp-linux-x64": {
        os: "linux",
        arch: "x64",
        extension: "",
        compiler: "g++",
        flags: ["-std=c++17", "-O2", "-Wall", "-Wextra", "-static"],
        language: 'cpp',
    },
    "cpp-linux-arm64": {
        os: "linux",
        arch: "arm64",
        extension: "",
        compiler: "aarch64-linux-gnu-g++",
        flags: ["-std=c++17", "-O2", "-Wall", "-Wextra", "-static"],
        language: 'cpp',
    },
    "cpp-windows-x64": {
        os: "windows",
        arch: "x64",
        extension: ".exe",
        compiler: "x86_64-w64-mingw32-g++",
        flags: ["-std=c++17", "-O2", "-Wall", "-Wextra", "-static"],
        language: 'cpp',
    },
}

const RUST_TARGETS: Record<string, BuildTarget> = {
    "rust-linux-x64": {
        os: "linux",
        arch: "x64",
        extension: "",
        compiler: "rustc",
        flags: ["-O"],
        language: 'rust',
    },
    "rust-windows-x64": {
        os: "windows",
        arch: "x64",
        extension: ".exe",
        compiler: "rustc",
        flags: ["-O", "--target", "x86_64-pc-windows-gnu"],
        language: 'rust',
    },
}

const BUILD_TARGETS: Record<string, BuildTarget> = { ...CPP_TARGETS, ...RUST_TARGETS }

// Interpreted languages
interface InterpretedLanguage {
    name: string
    extension: string
    runner: string
}

const INTERPRETED_LANGUAGES: Record<string, InterpretedLanguage> = {
    "python": { name: "Python", extension: ".py", runner: "python3" },
    "py": { name: "Python", extension: ".py", runner: "python3" },
    "javascript": { name: "JavaScript", extension: ".js", runner: "node" },
    "js": { name: "JavaScript", extension: ".js", runner: "node" },
    "ruby": { name: "Ruby", extension: ".rb", runner: "ruby" },
    "rb": { name: "Ruby", extension: ".rb", runner: "ruby" },
    "perl": { name: "Perl", extension: ".pl", runner: "perl" },
    "pl": { name: "Perl", extension: ".pl", runner: "perl" },
    "bash": { name: "Bash", extension: ".sh", runner: "bash" },
    "sh": { name: "Bash", extension: ".sh", runner: "bash" },
}

// ============================================
// Code Extraction
// ============================================

function extractCode(content: string): { code: string; error?: string } | null {
    const match = content.match(/```(?:cpp|c\+\+|c|rs|rust|py|python|js|javascript|rb|ruby|pl|perl|sh|bash)?\n([\s\S]*?)```/i)
    if (!match) return null
    
    const code = match[1].trim()
    
    // Validate code size
    if (code.length > MAX_CODE_SIZE) {
        return { code: '', error: `Code too large (${Math.round(code.length / 1024)}KB). Maximum is ${Math.round(MAX_CODE_SIZE / 1024)}KB.` }
    }
    
    return { code }
}

// ============================================
// Dangerous Patterns
// ============================================

const DANGEROUS_PATTERNS_CPP = [
    /\bsystem\s*\(/i,
    /\bexec[lv]?[pe]?\s*\(/i,
    /\bpopen\s*\(/i,
    /\bfork\s*\(/i,
    /#include\s*<windows\.h>/i,
]

const DANGEROUS_PATTERNS_RUST = [
    /\bstd::process::Command\b/i,
    /\bstd::process::Child\b/i,
]

const DANGEROUS_PATTERNS_PYTHON = [
    /\bos\.system\s*\(/i,
    /\bos\.popen\s*\(/i,
    /\bsubprocess\./i,
    /\beval\s*\(/i,
    /\bexec\s*\(/i,
    /\b__import__\s*\(/i,
]

const DANGEROUS_PATTERNS_JS = [
    /\brequire\s*\(\s*['"]child_process['"]\s*\)/i,
    /\bimport.*from\s*['"]child_process['"]/i,
    /\beval\s*\(/i,
]

const DANGEROUS_PATTERNS_RUBY = [
    /\bsystem\s*\(/i,
    /\b`[^`]+`/i,
    /\bexec\s*\(/i,
    /\bIO\.popen/i,
]

const DANGEROUS_PATTERNS_PERL = [
    /\bsystem\s*\(/i,
    /\bexec\s*\(/i,
    /\b`[^`]+`/i,
    /\bopen\s*\([^,]*\|/i,
    /\bqx\s*[\{\(\[]?/i,
]

const DANGEROUS_PATTERNS_BASH = [
    /\brm\s+-rf\s+\//i,
    /\brm\s+-rf\s+~/i,
    /\b:(){ :\|:& };:/i,
    /\bmkfs/i,
    /\bdd\s+if=/i,
]

function detectDangerousPatterns(code: string, language: string): string | null {
    let patterns: RegExp[] = []
    
    switch (language.toLowerCase()) {
        case 'cpp':
        case 'c':
            patterns = DANGEROUS_PATTERNS_CPP
            break
        case 'rust':
        case 'rs':
            patterns = DANGEROUS_PATTERNS_RUST
            break
        case 'python':
        case 'py':
            patterns = DANGEROUS_PATTERNS_PYTHON
            break
        case 'javascript':
        case 'js':
            patterns = DANGEROUS_PATTERNS_JS
            break
        case 'ruby':
        case 'rb':
            patterns = DANGEROUS_PATTERNS_RUBY
            break
        case 'perl':
        case 'pl':
            patterns = DANGEROUS_PATTERNS_PERL
            break
        case 'bash':
        case 'sh':
            patterns = DANGEROUS_PATTERNS_BASH
            break
    }
    
    for (const pattern of patterns) {
        if (pattern.test(code)) {
            return `Unsafe code pattern detected`
        }
    }
    return null
}

// ============================================
// Build Function
// ============================================

interface BuildResult {
    success: boolean
    output: string
    binaryPath?: string
    binaryName?: string
    binarySize?: number
}

async function doBuild(code: string, targetKey: string): Promise<BuildResult> {
    const target = BUILD_TARGETS[targetKey]
    if (!target) {
        return {
            success: false,
            output: `Unknown target: ${targetKey}. Use: ${Object.keys(BUILD_TARGETS).join(", ")}`,
        }
    }

    const dangerousPattern = detectDangerousPatterns(code, target.language)
    if (dangerousPattern) {
        return { success: false, output: dangerousPattern }
    }

    const tempDir = mkdtempSync(join(tmpdir(), "stoat-"))
    const isRust = target.language === 'rust'
    const sourceExt = isRust ? '.rs' : '.cpp'
    const sourceFile = join(tempDir, `main${sourceExt}`)
    const outputName = `main${target.extension}`
    const outputFile = join(tempDir, outputName)

    log(`Building ${targetKey} in ${tempDir}`)

    return new Promise((resolve) => {
        try {
            writeFileSync(sourceFile, code, "utf-8")
            
            let compileCmd: string
            if (isRust) {
                compileCmd = `${target.compiler} ${target.flags.join(" ")} -o /output/${outputName} /src/main${sourceExt} 2>&1`
            } else {
                compileCmd = `${target.compiler} ${target.flags.join(" ")} -o /output/${outputName} /src/main${sourceExt} 2>&1`
            }

            log(`Compile command: ${compileCmd}`)

            const child = spawn("podman", [
                "run", "--rm",
                "--network=none",
                "--memory=512m",
                "--cpus=2",
                "--pids-limit=100",
                `-v=${tempDir}:/src:ro`,
                `-v=${tempDir}:/output:rw`,
                "stoat-compiler:latest",
                "bash", "-c",
                compileCmd,
            ])

            let output = ""
            child.stdout.on("data", (d) => { output += d })
            child.stderr.on("data", (d) => { output += d })

            child.on("close", (exitCode) => {
                log(`Compile exit code: ${exitCode}`)
                if (exitCode === 0 && existsSync(outputFile)) {
                    const stats = statSync(outputFile)
                    resolve({
                        success: true,
                        output,
                        binaryPath: outputFile,
                        binaryName: outputName,
                        binarySize: stats.size,
                    })
                } else {
                    resolve({ success: false, output: output || "Build failed" })
                    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
                }
            })

            child.on("error", (err) => {
                log(`Compile error:`, err)
                resolve({ success: false, output: `Container error: ${err.message}` })
            })

        } catch (err) {
            log(`Build exception:`, err)
            resolve({ success: false, output: String(err) })
        }
    })
}

// ============================================
// Syntax Check
// ============================================

interface SyntaxResult {
    status: 'perfect' | 'passable' | 'failed'
    output: string
    warningCount: number
    errorCount: number
}

async function doSyntaxCheck(code: string, language: string = 'cpp'): Promise<SyntaxResult> {
    const dangerousPattern = detectDangerousPatterns(code, language)
    if (dangerousPattern) {
        return { status: 'failed', output: dangerousPattern, warningCount: 0, errorCount: 1 }
    }

    const tempDir = mkdtempSync(join(tmpdir(), "stoat-syntax-"))
    const langConfig = INTERPRETED_LANGUAGES[language.toLowerCase()]
    
    let sourceExt = '.cpp'
    let syntaxCmd = "g++ -fsyntax-only -std=c++17 -Wall -Wextra /src/main.cpp 2>&1"
    
    if (langConfig) {
        sourceExt = langConfig.extension
        if (langConfig.runner === 'python3') {
            syntaxCmd = "python3 -m py_compile /src/main.py 2>&1"
        } else if (langConfig.runner === 'node') {
            syntaxCmd = "node --check /src/main.js 2>&1"
        } else if (langConfig.runner === 'ruby') {
            syntaxCmd = "ruby -c /src/main.rb 2>&1"
        } else if (langConfig.runner === 'perl') {
            syntaxCmd = "perl -c /src/main.pl 2>&1"
        } else if (langConfig.runner === 'bash') {
            syntaxCmd = "bash -n /src/main.sh 2>&1"
        }
    } else if (language.toLowerCase() === 'rust' || language.toLowerCase() === 'rs') {
        sourceExt = '.rs'
        syntaxCmd = "rustc --error-format=short /src/main.rs -o /dev/null 2>&1 || true"
    }

    const sourceFile = join(tempDir, `main${sourceExt}`)

    return new Promise((resolve) => {
        try {
            writeFileSync(sourceFile, code, "utf-8")

            const child = spawn("podman", [
                "run", "--rm",
                "--network=none",
                "--memory=128m",
                "--cpus=1",
                `-v=${tempDir}:/src:ro`,
                "stoat-compiler:latest",
                "bash", "-c",
                syntaxCmd,
            ])

            let output = ""
            child.stdout.on("data", (d) => { output += d })
            child.stderr.on("data", (d) => { output += d })

            child.on("close", (exitCode) => {
                rmSync(tempDir, { recursive: true, force: true })
                
                const warnings = (output.match(/warning:/gi) || []).length
                const errors = (output.match(/error:/gi) || []).length
                
                if (exitCode === 0 && output.trim() === '') {
                    resolve({ status: 'perfect', output: '', warningCount: 0, errorCount: 0 })
                } else if (exitCode === 0 && warnings > 0) {
                    resolve({ status: 'passable', output, warningCount: warnings, errorCount: 0 })
                } else if (exitCode !== 0) {
                    resolve({ status: 'failed', output, warningCount: warnings, errorCount: errors })
                } else {
                    resolve({ status: 'passable', output, warningCount: warnings, errorCount: 0 })
                }
            })

            child.on("error", (err) => {
                rmSync(tempDir, { recursive: true, force: true })
                resolve({ status: 'failed', output: err.message, warningCount: 0, errorCount: 1 })
            })

        } catch (err) {
            resolve({ status: 'failed', output: String(err), warningCount: 0, errorCount: 1 })
        }
    })
}

// ============================================
// Code Execution
// ============================================

interface RunResult {
    success: boolean
    output: string
    timedOut: boolean
    exitCode: number | null
    executionTime: number
}

async function doRunCode(
    code: string, 
    language: string,
    updateCallback: (status: string) => Promise<void>
): Promise<RunResult> {
    log(`doRunCode called with language: ${language}`)
    
    const dangerousPattern = detectDangerousPatterns(code, language)
    if (dangerousPattern) {
        return { success: false, output: dangerousPattern, timedOut: false, exitCode: 1, executionTime: 0 }
    }

    const tempDir = mkdtempSync(join(tmpdir(), "stoat-run-"))
    const startTime = Date.now()
    
    const langConfig = INTERPRETED_LANGUAGES[language.toLowerCase()]
    
    let sourceExt = '.cpp'
    let runner = ''
    let needsCompile = false
    
    if (langConfig) {
        sourceExt = langConfig.extension
        runner = langConfig.runner
        needsCompile = false
    } else if (language.toLowerCase() === 'cpp' || language.toLowerCase() === 'c') {
        sourceExt = '.cpp'
        needsCompile = true
    } else if (language.toLowerCase() === 'rust' || language.toLowerCase() === 'rs') {
        sourceExt = '.rs'
        needsCompile = true
    } else {
        rmSync(tempDir, { recursive: true, force: true })
        return { success: false, output: `Unknown language: ${language}`, timedOut: false, exitCode: 1, executionTime: 0 }
    }

    const sourceFile = join(tempDir, `main${sourceExt}`)
    const binaryFile = join(tempDir, 'main')

    log(`Temp dir: ${tempDir}, needsCompile: ${needsCompile}`)

    try {
        writeFileSync(sourceFile, code, "utf-8")
        
        if (needsCompile) {
            // Update status first, then compile
            await updateCallback("Compiling...")
            
            const compileCmd = language.toLowerCase() === 'rust' 
                ? "rustc -O /src/main.rs -o /output/main 2>&1"
                : "g++ -std=c++17 -O2 /src/main.cpp -o /output/main 2>&1"
            
            log(`Compile command: ${compileCmd}`)
            
            const compileResult = await runContainerCommand([
                "run", "--rm",
                "--network=none",
                "--memory=256m",
                "--cpus=1",
                `-v=${tempDir}:/src:ro`,
                `-v=${tempDir}:/output:rw`,
                "stoat-compiler:latest",
                "bash", "-c",
                compileCmd,
            ])
            
            log(`Compile exit code: ${compileResult.exitCode}`)
            
            if (compileResult.exitCode !== 0 || !existsSync(binaryFile)) {
                rmSync(tempDir, { recursive: true, force: true })
                return { 
                    success: false, 
                    output: `Compilation failed:\n${compileResult.output}`, 
                    timedOut: false, 
                    exitCode: compileResult.exitCode,
                    executionTime: Date.now() - startTime
                }
            }
            
            // Run the binary
            await updateCallback("Running...")
            log("Executing binary...")
            
            const runResult = await runContainerCommand([
                "run", "--rm",
                "--network=none",
                "--memory=128m",
                "--cpus=1",
                "--pids-limit=10",
                `-v=${tempDir}:/app:ro`,
                "--workdir=/app",
                "stoat-compiler:latest",
                "timeout", "5s",
                "./main",
            ], 5500)
            
            log(`Binary exit code: ${runResult.exitCode}, timedOut: ${runResult.timedOut}`)
            rmSync(tempDir, { recursive: true, force: true })
            
            return {
                success: runResult.exitCode === 0,
                output: runResult.output || "(no output)",
                timedOut: runResult.timedOut,
                exitCode: runResult.exitCode,
                executionTime: Date.now() - startTime,
            }
        } else {
            // Interpreted language - run directly
            await updateCallback(`Running with ${runner}...`)
            
            const runCmd = `${runner} /src/main${sourceExt} 2>&1`
            log(`Run command: ${runCmd}`)
            
            const runResult = await runContainerCommand([
                "run", "--rm",
                "--network=none",
                "--memory=128m",
                "--cpus=1",
                "--pids-limit=20",
                `-v=${tempDir}:/src:ro`,
                "stoat-compiler:latest",
                "timeout", "5s",
                "bash", "-c",
                runCmd,
            ], 5500)
            
            log(`Run exit code: ${runResult.exitCode}, timedOut: ${runResult.timedOut}`)
            rmSync(tempDir, { recursive: true, force: true })
            
            return {
                success: runResult.exitCode === 0,
                output: runResult.output || "(no output)",
                timedOut: runResult.timedOut,
                exitCode: runResult.exitCode,
                executionTime: Date.now() - startTime,
            }
        }
    } catch (err) {
        log(`doRunCode exception:`, err)
        rmSync(tempDir, { recursive: true, force: true })
        return { 
            success: false, 
            output: String(err), 
            timedOut: false, 
            exitCode: 1,
            executionTime: Date.now() - startTime
        }
    }
}

// Helper function to run a container command with optional timeout
async function runContainerCommand(args: string[], killTimeout?: number): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
        const child = spawn("podman", args)
        
        let output = ""
        let timedOut = false
        let resolved = false
        
        child.stdout.on("data", (d) => { output += d })
        child.stderr.on("data", (d) => { output += d })
        
        let timeout: NodeJS.Timeout | null = null
        if (killTimeout) {
            timeout = setTimeout(() => {
                if (!resolved) {
                    timedOut = true
                    child.kill('SIGKILL')
                }
            }, killTimeout)
        }
        
        child.on("close", (exitCode) => {
            if (resolved) return
            resolved = true
            if (timeout) clearTimeout(timeout)
            resolve({ output, exitCode, timedOut })
        })
        
        child.on("error", (err) => {
            if (resolved) return
            resolved = true
            if (timeout) clearTimeout(timeout)
            resolve({ output: `Container error: ${err.message}`, exitCode: 1, timedOut: false })
        })
    })
}

// ============================================
// Permissions
// ============================================

const PERMISSION_GRANT_ALL = 1 << 0
const PERMISSION_MANAGE_SERVER = 1 << 1
const PERMISSION_MANAGE_ROLES = 1 << 3

function hasAdminPermission(permissions: number): boolean {
    return (permissions & PERMISSION_GRANT_ALL) !== 0 ||
           (permissions & PERMISSION_MANAGE_SERVER) !== 0 ||
           (permissions & PERMISSION_MANAGE_ROLES) !== 0
}

async function isAdmin(msg: any, config: BotConfig): Promise<boolean> {
    if (config.adminUsers.includes(msg.authorId)) return true

    const server = msg.channel?.server
    if (!server) {
        return config.adminUsers.length === 0 && config.adminRoleIds.length === 0
    }

    const ownerId = (server as any).ownerId || (server as any).owner?.id
    if (ownerId && ownerId === msg.authorId) {
        return true
    }

    if (msg.member?.roles) {
        const roles = (server as any).roles
        const memberRoles = msg.member.roles

        for (const roleId of memberRoles) {
            if (config.adminRoleIds.includes(roleId)) return true

            if (roles) {
                let roleData: any = null
                if (roles instanceof Map) {
                    roleData = roles.get(roleId)
                } else if (typeof roles === 'object') {
                    roleData = roles[roleId]
                }
                
                if (roleData && roleData.permissions !== undefined) {
                    if (hasAdminPermission(roleData.permissions)) {
                        return true
                    }
                }
            }
        }
    }

    if (config.adminUsers.length === 0 && config.adminRoleIds.length === 0) return true
    return false
}

// ============================================
// Command Handler
// ============================================

async function handleCommand(msg: any, config: BotConfig): Promise<string | BuildResponse | RunResponse | null> {
    const content = msg.content
    if (!content || !content.startsWith(config.prefix)) return null
    if (config.allowedChannelId && msg.channelId !== config.allowedChannelId) return null

    const parts = content.slice(config.prefix.length).split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    switch (cmd) {
        case "help":
            return `**Stoat - Multi-Language Compiler Bot**

\`${config.prefix}help\` - Show this help
\`${config.prefix}targets\` - List build targets
\`${config.prefix}languages\` - List interpreted languages
\`${config.prefix}status\` - Bot status
\`${config.prefix}verify\` - Check container tools
\`${config.prefix}syntax [lang]\` - Check syntax (use code block)
\`${config.prefix}build <target>\` - Build binary (use code block)
\`${config.prefix}run <lang>\` - Run code with 5s timeout

**Build Targets (C++):**
\`cpp-linux-x64\`, \`cpp-linux-arm64\`, \`cpp-windows-x64\`

**Build Targets (Rust):**
\`rust-linux-x64\`, \`rust-windows-x64\`

**Interpreted Languages:**
\`python\`, \`javascript\`, \`ruby\`, \`perl\`, \`bash\`

**Channel Management:**
\`${config.prefix}channel\` - Show channel restriction
\`${config.prefix}channel set\` - Restrict to this channel
\`${config.prefix}channel clear\` - Remove restriction

**Admin Management:**
\`${config.prefix}admin\` - List admins
\`${config.prefix}admin add <user_id>\` - Add admin

**Utility:**
\`${config.prefix}myid\` - Show your user ID
\`${config.prefix}debug\` - Debug info`

        case "targets": {
            let t = "**Build Targets**\n\n**C++ Targets:**\n"
            for (const [key, target] of Object.entries(CPP_TARGETS)) {
                t += `\`${key}\` - ${target.os} ${target.arch}\n`
            }
            t += "\n**Rust Targets:**\n"
            for (const [key, target] of Object.entries(RUST_TARGETS)) {
                t += `\`${key}\` - ${target.os} ${target.arch}\n`
            }
            return t
        }

        case "languages": {
            let t = "**Interpreted Languages**\n\n"
            const seen = new Set<string>()
            for (const [key, lang] of Object.entries(INTERPRETED_LANGUAGES)) {
                if (!seen.has(lang.name)) {
                    t += `\`${key}\` - ${lang.name}\n`
                    seen.add(lang.name)
                }
            }
            t += `\nUse \`${config.prefix}run <lang>\` with a code block to execute.`
            return t
        }

        case "status": {
            const queueInfo = buildQueue.length > 0 ? ` (${buildQueue.length} in queue)` : ""
            const channel = config.allowedChannelId ? `<#${config.allowedChannelId}>` : "All"
            return `**Stoat Status**

**Channel:** ${channel}
**Prefix:** \`${config.prefix}\`
**Queue:** ${isProcessing ? "Processing..." : "Idle"}${queueInfo}
**Admin Users:** ${config.adminUsers.length}`
        }

        case "verify": {
            // Check if container has all required tools
            return enqueueBuild(async () => {
                const tools = [
                    { name: 'g++', cmd: 'g++ --version | head -1' },
                    { name: 'rustc', cmd: 'rustc --version' },
                    { name: 'python3', cmd: 'python3 --version' },
                    { name: 'node', cmd: 'node --version' },
                    { name: 'ruby', cmd: 'ruby --version' },
                    { name: 'perl', cmd: 'perl -v | head -2 | tail -1' },
                    { name: 'timeout', cmd: 'timeout --version | head -1' },
                ]
                
                const results: string[] = ["**Container Verification**\n"]
                
                for (const tool of tools) {
                    const result = await new Promise<string>((resolve) => {
                        const child = spawn("podman", [
                            "run", "--rm",
                            "--network=none",
                            "stoat-compiler:latest",
                            "bash", "-c",
                            tool.cmd,
                        ])
                        
                        let output = ""
                        child.stdout.on("data", (d) => { output += d })
                        child.stderr.on("data", (d) => { output += d })
                        
                        child.on("close", (code) => {
                            if (code === 0) {
                                resolve(`✅ ${tool.name}: ${output.trim()}`)
                            } else {
                                resolve(`❌ ${tool.name}: Not found (exit ${code})`)
                            }
                        })
                        
                        child.on("error", () => {
                            resolve(`❌ ${tool.name}: Container error`)
                        })
                    })
                    
                    results.push(result)
                }
                
                return results.join("\n")
            }) as Promise<string>
        }

        case "myid":
            return `**Your User ID:** \`${msg.authorId}\``

        case "debug": {
            const server = msg.channel?.server
            const lines = [
                "**Debug Info**",
                `**Author ID:** ${msg.authorId}`,
                `**Channel ID:** ${msg.channelId}`,
                `**Server ID:** ${server?.id || "Not in server"}`,
                `**Server Owner ID:** ${(server as any)?.ownerId || "Unknown"}`,
                `**Member roles:** ${JSON.stringify(msg.member?.roles || [])}`,
                `**Is Admin:** ${await isAdmin(msg, config)}`,
            ]
            return lines.join("\n")
        }

        case "roles": {
            const server = msg.channel?.server
            if (!server) return "This command must be used in a server."

            try {
                const roles = (server as any).roles
                if (!roles) return "No roles found."

                const lines = ["**Server Roles**\n"]
                if (roles instanceof Map) {
                    for (const [id, role] of roles) {
                        const r = role as any
                        lines.push(`**${r.name || "Unknown"}** - \`${id}\` (perms: ${r.permissions || 0})`)
                    }
                } else if (typeof roles === 'object') {
                    for (const [id, role] of Object.entries(roles)) {
                        const r = role as any
                        lines.push(`**${r.name || "Unknown"}** - \`${id}\` (perms: ${r.permissions || 0})`)
                    }
                }
                return lines.join("\n")
            } catch (err) {
                log("Error fetching roles:", err)
                return "Could not fetch server roles."
            }
        }

        case "admin": {
            if (!(await isAdmin(msg, config))) return "Admin required."

            const subCmd = parts[1]?.toLowerCase()
            const targetId = parts[2]

            if (subCmd === "add" && targetId) {
                if (config.adminUsers.includes(targetId)) {
                    return `User ${targetId} is already an admin.`
                }
                config.adminUsers.push(targetId)
                saveConfig(config)
                return `Added admin: ${targetId}`
            }

            if (subCmd === "remove" && targetId) {
                const idx = config.adminUsers.indexOf(targetId)
                if (idx === -1) {
                    return `User ${targetId} is not an admin.`
                }
                config.adminUsers.splice(idx, 1)
                saveConfig(config)
                return `Removed admin: ${targetId}`
            }

            const userList = config.adminUsers.length
                ? config.adminUsers.map(id => `${id}`).join("\n")
                : "None"

            return `**Admin Users**\n${userList}\n\nUse \`${config.prefix}admin add <user_id>\` to add.`
        }

        case "channel": {
            if (!(await isAdmin(msg, config))) return "Admin required."

            const subCmd = parts[1]?.toLowerCase()
            if (subCmd === "set") {
                config.allowedChannelId = msg.channelId
                saveConfig(config)
                return `Bot restricted to this channel: <#${msg.channelId}>`
            }
            if (subCmd === "clear") {
                config.allowedChannelId = null
                saveConfig(config)
                return "Channel restriction removed."
            }

            const current = config.allowedChannelId
                ? `<#${config.allowedChannelId}>`
                : "All channels"
            return `**Current Channel:** ${current}`
        }

        case "syntax": {
            const lang = parts[1]?.toLowerCase() || 'cpp'
            const langIndex = INTERPRETED_LANGUAGES[lang] ? content.indexOf(lang) + lang.length : content.indexOf("syntax") + 6
            const extracted = extractCode(content.slice(langIndex))
            if (!extracted) return "No code block found. Use `!syntax [lang]` followed by a code block."
            if (extracted.error) return `❌ **Error:** ${extracted.error}`
            const code = extracted.code

            const actualLang = INTERPRETED_LANGUAGES[lang] ? lang : (lang === 'rust' || lang === 'rs') ? 'rust' : 'cpp'

            return enqueueBuild(async () => {
                const result = await doSyntaxCheck(code, actualLang)
                
                if (result.status === 'perfect') {
                    return `✅ **Syntax Perfect**\nNo warnings or errors detected.`
                } else if (result.status === 'passable') {
                    return `⚠️ **Syntax Passable** (${result.warningCount} warning${result.warningCount !== 1 ? 's' : ''})\n\`\`\`\n${result.output}\n\`\`\``
                } else {
                    return `❌ **Syntax Failed** (${result.errorCount} error${result.errorCount !== 1 ? 's' : ''})\n\`\`\`\n${result.output}\n\`\`\``
                }
            }) as Promise<string>
        }

        case "run": {
            const lang = parts[1]?.toLowerCase()
            if (!lang) {
                return `Specify language: python, javascript, ruby, perl, bash, cpp, rust`
            }

            const langIndex = content.indexOf(lang) + lang.length
            const extracted = extractCode(content.slice(langIndex))
            if (!extracted) return "No code block found. Use `!run <lang>` followed by a code block."
            if (extracted.error) return `❌ **Error:** ${extracted.error}`
            const code = extracted.code

            const isSupported = INTERPRETED_LANGUAGES[lang] || lang === 'cpp' || lang === 'rust' || lang === 'rs'
            if (!isSupported) {
                return `Unsupported language: ${lang}`
            }

            return enqueueBuild(async () => {
                log(`Starting run for ${lang}`)
                
                // Send initial message
                let statusMsg: any = null
                try {
                    statusMsg = await msg.channel?.sendMessage("⏳ **Running code...**")
                    log("Initial status message sent, id:", statusMsg?.id)
                } catch (e) {
                    log("Failed to send initial message:", e)
                }
                
                // Run code without intermediate updates (they may be causing issues)
                const result = await doRunCode(code, lang, async (status: string) => {
                    // Skip intermediate updates - just log them
                    log(`Status: ${status}`)
                })
                
                log(`Run completed: success=${result.success}, timedOut=${result.timedOut}, output=${result.output.substring(0, 200)}`)
                
                // Format final result
                let finalContent = ""
                if (result.timedOut) {
                    finalContent = `⏱️ **Execution Timed Out** (5s limit)\n**Partial Output:**\n\`\`\`\n${result.output.substring(0, 1900)}\n\`\`\``
                } else if (result.success) {
                    finalContent = `✅ **Execution Successful** (${result.executionTime}ms)\n**Output:**\n\`\`\`\n${result.output.substring(0, 1900)}\n\`\`\``
                } else {
                    // Check for command not found error
                    const isCommandNotFound = result.exitCode === 127 || result.output.includes('command not found')
                    if (isCommandNotFound) {
                        finalContent = `❌ **Execution Failed** (exit code: ${result.exitCode})\n**Error:** Interpreter not found in container.\n\nPlease rebuild the container:\n\`\`\`bash\npodman build -t stoat-compiler:latest .\n\`\`\`\n**Output:**\n\`\`\`\n${result.output.substring(0, 1400)}\n\`\`\``
                    } else {
                        finalContent = `❌ **Execution Failed** (exit code: ${result.exitCode})\n**Output:**\n\`\`\`\n${result.output.substring(0, 1900)}\n\`\`\``
                    }
                }
                
                // Edit the status message with final result
                if (statusMsg) {
                    try {
                        // Small delay to ensure message is fully propagated
                        await new Promise(r => setTimeout(r, 100))
                        
                        log("Attempting to edit message with content length:", finalContent.length)
                        
                        // Try edit first
                        const editResult = await statusMsg.edit(finalContent)
                        log("Edit result:", editResult ? "success" : "null/undefined")
                        
                        // Check if edit actually worked by deleting and resending
                        // This is a workaround for stoat.js edit not reflecting on server
                        try {
                            await statusMsg.delete()
                            log("Deleted old message")
                            await msg.channel?.sendMessage(finalContent)
                            log("Sent new message with result")
                        } catch (delErr) {
                            log("Delete/send fallback failed:", delErr)
                            // If delete fails, the edit might have worked
                            log("Final result message edited (via edit)")
                        }
                    } catch (e) {
                        log("Failed to edit final message:", e)
                        // Fallback: send new message
                        try {
                            await msg.channel?.sendMessage(finalContent)
                            log("Sent fallback message")
                        } catch (e2) {
                            log("Fallback message also failed:", e2)
                        }
                    }
                }
                
                return null
            }) as Promise<RunResponse | null>
        }

        case "build": {
            const target = parts[1]?.toLowerCase()
            if (!target || !BUILD_TARGETS[target]) {
                return `Specify target: ${Object.keys(BUILD_TARGETS).join(", ")}`
            }

            const afterTarget = content.slice(content.indexOf(target) + target.length)
            const extracted = extractCode(afterTarget)
            if (!extracted) return "No code block found. Use `!build <target>` followed by a code block."
            if (extracted.error) return `❌ **Error:** ${extracted.error}`
            const code = extracted.code

            return enqueueBuild(async () => {
                const result = await doBuild(code, target)
                if (result.success && result.binaryPath) {
                    return {
                        type: 'build' as const,
                        content: `**Built for ${BUILD_TARGETS[target].os}-${BUILD_TARGETS[target].arch}**\n**Language:** ${BUILD_TARGETS[target].language.toUpperCase()}\n**Size:** ${Math.round((result.binarySize || 0) / 1024)} KB`,
                        binaryPath: result.binaryPath,
                        binaryName: result.binaryName || "binary",
                        targetKey: target,
                    }
                }
                return `**Build Failed**\n\`\`\`\n${result.output}\n\`\`\``
            }) as Promise<string | BuildResponse>
        }

        default:
            return null
    }
}

// ============================================
// Zip Helper
// ============================================

async function zipFile(filePath: string, originalName: string): Promise<{ path: string; name: string }> {
    const tempDir = dirname(filePath)
    const randomId = generateRandomId(8)
    const baseName = originalName.replace(/\.exe$/, '')
    const zipName = `${baseName}-${randomId}.zip`
    const zipPath = join(tempDir, zipName)
    
    return new Promise((resolve, reject) => {
        const output = createWriteStream(zipPath)
        const archive = archiver('zip', { zlib: { level: 9 } })
        
        output.on('close', () => {
            resolve({ path: zipPath, name: zipName })
        })
        
        archive.on('error', (err: Error) => {
            reject(err)
        })
        
        archive.pipe(output)
        archive.file(filePath, { name: originalName })
        archive.finalize()
    })
}

// ============================================
// File Upload
// ============================================

const client = new Client()

async function uploadToStoat(filePath: string, fileName: string): Promise<string | null> {
    const autumnUrl = (client as any).configuration?.features?.autumn?.url || "https://autumn.revolt.chat"
    const authToken = BOT_TOKEN
    
    log(`Uploading to Stoat: ${autumnUrl}/attachments`)
    
    const fileBuffer = readFileSync(filePath)
    const FormData = (await import('form-data')).default
    const form = new FormData()
    form.append('file', fileBuffer, {
        filename: fileName,
        contentType: 'application/octet-stream',
        knownLength: fileBuffer.length,
    })
    
    try {
        const response = await axios.post(`${autumnUrl}/attachments`, form, {
            headers: {
                'X-Bot-Token': authToken,
                ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        })
        
        if (response.data?.id) {
            return response.data.id
        }
        return null
    } catch (err: any) {
        const data = err.response?.data
        if (data?.type === 'FileTypeNotAllowed') {
            log('Stoat blocked this file type')
            return null
        }
        log(`Stoat upload error: ${err.message}`)
        return null
    }
}

async function uploadToVikingfile(filePath: string, fileName: string): Promise<string | null> {
    const fileBuffer = readFileSync(filePath)
    
    log('Uploading to vikingfile.com...')
    try {
        const serverRes = await axios.get('https://vikingfile.com/api/get-server', { timeout: 30000 })
        const server = serverRes.data?.server
        
        if (!server) {
            throw new Error('No server returned')
        }
        
        log(`Using server: ${server}`)
        
        const FormData = (await import('form-data')).default
        const form = new FormData()
        form.append('file', fileBuffer, fileName)
        form.append('user', '')
        
        const uploadRes = await axios.post(server, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000,
        })
        
        if (uploadRes.data?.url) {
            log(`vikingfile.com upload successful: ${uploadRes.data.url}`)
            return uploadRes.data.url
        }
    } catch (err: any) {
        log(`vikingfile.com error: ${err.message}`)
    }
    
    return null
}

async function uploadFile(filePath: string, fileName: string): Promise<{ type: 'stoat' | 'external', id: string, url?: string }> {
    const stoatId = await uploadToStoat(filePath, fileName)
    if (stoatId) {
        return { type: 'stoat', id: stoatId }
    }
    
    const externalUrl = await uploadToVikingfile(filePath, fileName)
    if (externalUrl) {
        return { type: 'external', id: externalUrl, url: externalUrl }
    }
    
    throw new Error('All upload methods failed')
}

// ============================================
// Client Events
// ============================================

client.on("ready", async () => {
    log(`Stoat connected as ${client.user?.username}`)
})

client.on("error", (err: any) => {
    log("Client error:", err)
})

client.on("messageCreate", async (msg: any) => {
    log(`Received message from ${msg.authorId}: "${msg.content?.substring(0, 50)}..."`)

    try {
        const result = await handleCommand(msg, config)
        if (!result) return

        if (typeof result === "string") {
            await msg.channel?.sendMessage(result)
        } else if (result === null) {
            return
        } else if (result.type === 'run') {
            await msg.channel?.sendMessage(result.content)
        } else if (result.type === 'build') {
            try {
                log(`Zipping file: ${result.binaryPath}`)
                
                const zipInfo = await zipFile(result.binaryPath, result.binaryName)
                log(`Created zip: ${zipInfo.path}`)
                
                const uploadResult = await uploadFile(zipInfo.path, zipInfo.name)
                log(`Upload result:`, uploadResult)
                
                if (uploadResult.type === 'stoat') {
                    await msg.channel?.sendMessage({
                        content: result.content,
                        attachments: [uploadResult.id],
                    })
                } else {
                    await msg.channel?.sendMessage({
                        content: `${result.content}\n\n📥 **Download:** ${uploadResult.url}`,
                    })
                }
                
                rmSync(zipInfo.path, { force: true })
            } catch (e: any) {
                log("Attachment failed:", e)
                await msg.channel?.sendMessage(`${result.content}\n\n(Binary upload failed: ${e?.message || e})`)
            }
            rmSync(result.binaryPath, { force: true })
        }
    } catch (err) {
        log("Error in message handler:", err)
    }
})

client.loginBot(BOT_TOKEN)
log("Stoat starting...")

// ============================================
// Graceful Shutdown
// ============================================

const activeContainers: Set<string> = new Set()

function cleanup() {
    log("Shutting down...")
    
    // Kill any active container processes
    if (activeContainers.size > 0) {
        log(`Cleaning up ${activeContainers.size} active containers...`)
        for (const containerId of activeContainers) {
            try {
                spawn("podman", ["kill", containerId])
            } catch {}
        }
    }
    
    process.exit(0)
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)
process.on("uncaughtException", (err) => {
    log("Uncaught exception:", err)
    cleanup()
})
process.on("unhandledRejection", (reason) => {
    log("Unhandled rejection:", reason)
})
