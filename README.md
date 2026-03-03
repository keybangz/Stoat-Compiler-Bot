# Stoat Compiler Bot

A multi-language compiler and code execution bot for [Stoat](https://github.com/stoatchat/for-web). Compile C++ and Rust applications with cross-compilation support, or execute interpreted languages like Python, JavaScript, Ruby, Perl, and Bash in a secure containerized environment.

## Features

- **C++ Compilation**: Cross-compile for Linux (x64, ARM64) and Windows (x64) with static linking
- **Rust Compilation**: Build for Linux (x64) and Windows (x64) with cross-compilation support
- **Interpreted Languages**: Execute Python, JavaScript, Ruby, Perl, and Bash code
- **Syntax Checking**: Validate code syntax without compilation for all supported languages
- **Security**: Code execution in isolated Podman containers with:
  - Network isolation (`--network=none`)
  - Memory limits (128-512MB)
  - CPU limits (1-2 CPUs)
  - Process limits (10-100 PIDs)
  - Execution timeout (5 seconds)
  - Dangerous pattern detection
- **Admin System**: Role-based and user-based administration
- **Channel Restriction**: Limit bot to specific channels
- **Build Queue**: Sequential processing of compilation requests

## Requirements

- Node.js 18+ 
- pnpm (recommended) or npm
- Podman (for containerized compilation/execution)
- Stoat account with bot token

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/stoat-compiler-bot.git
cd stoat-compiler-bot
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Build the Container Image

```bash
podman build -t stoat-compiler:latest .
```

This will create the compiler container with all necessary tools:
- g++ (C++ compiler)
- rustc (Rust compiler)
- python3
- node (Node.js)
- ruby
- perl
- bash

### 4. Create Environment File

Create a `.env` file in the project root:

```env
STOAT_TOKEN=your_bot_token_here
# or
REVOLT_TOKEN=your_bot_token_here
```

### 5. Run the Bot

```bash
# Development mode (with hot reload)
pnpm run dev

# Production mode
pnpm run build
pnpm start
```

## Commands

### General Commands

| Command | Description |
|---------|-------------|
| `!help` | Show available commands |
| `!targets` | List all build targets |
| `!languages` | List supported interpreted languages |
| `!status` | Show bot status and queue info |
| `!verify` | Verify container tools are installed |
| `!myid` | Show your user ID |
| `!debug` | Show debug information |

### Compilation Commands
Please note `codeblock` refers to the method applications like Stoat, Github & Discord use to create syntax highlighting for code blocks. (/```/)
- If snippet posted is not wrapped in the required codeblock will not be processed. 

#### Build Binary

```
!build <target>

`codeblock`
code here
`codeblock`
```

**Example:**
```
!build cpp-linux-x64

`codeblock`cpp
#include <iostream>
int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`codeblock`
```

#### Run Code

```
!run <language>
`codeblock`language
code here
`codeblock`
```

**Example:**
```
!run python
`codeblock`py
for i in range(10):
    print(f"Count: {i}")
`codeblock`
```

#### Syntax Check

```
!syntax [language]
`codeblock`language
code here
`codeblock`
```

**Example:**
```
!syntax rust
`codeblock`rust
fn main() {
    println!("Hello");
}
`codeblock`
```

### Admin Commands

| Command | Description |
|---------|-------------|
| `!admin` | List admin users |
| `!admin add <user_id>` | Add admin user |
| `!admin remove <user_id>` | Remove admin user |
| `!roles` | List server roles with permissions |

### Channel Commands

| Command | Description |
|---------|-------------|
| `!channel` | Show current channel restriction |
| `!channel set` | Restrict bot to current channel |
| `!channel clear` | Remove channel restriction |

## Build Targets

### C++ Targets

| Target | OS | Architecture | Output |
|--------|-----|--------------|--------|
| `cpp-linux-x64` | Linux | x86_64 | ELF binary |
| `cpp-linux-arm64` | Linux | ARM64 | ELF binary |
| `cpp-windows-x64` | Windows | x86_64 | .exe |

### Rust Targets

| Target | OS | Architecture | Output |
|--------|-----|--------------|--------|
| `rust-linux-x64` | Linux | x86_64 | ELF binary |
| `rust-windows-x64` | Windows | x86_64 | .exe |

## Interpreted Languages

| Language | Aliases | Runner |
|----------|---------|--------|
| Python | `python`, `py` | python3 |
| JavaScript | `javascript`, `js` | node |
| Ruby | `ruby`, `rb` | ruby |
| Perl | `perl`, `pl` | perl |
| Bash | `bash`, `sh` | bash |

## Security Features

### Container Isolation

All code execution happens in isolated Podman containers with:

- **Network Isolation**: No network access during execution
- **Memory Limits**: 128MB for execution, 256-512MB for compilation
- **CPU Limits**: 1-2 CPUs per container
- **Process Limits**: Maximum 10-100 processes
- **Timeout**: 5-second execution limit with forced termination

### Dangerous Pattern Detection

The bot blocks code containing potentially dangerous patterns:

#### C/C++
- `system()`, `exec()`, `popen()`, `fork()`
- `#include <windows.h>`

#### Rust
- `std::process::Command`, `std::process::Child`

#### Python
- `os.system()`, `os.popen()`, `subprocess.*`
- `eval()`, `exec()`, `__import__()`

#### JavaScript
- `require('child_process')`, `import from 'child_process'`
- `eval()`

#### Ruby
- `system()`, backticks, `exec()`, `IO.popen`

#### Bash
- `rm -rf /`, `rm -rf ~`
- Fork bombs, `mkfs`, `dd if=`

## Configuration

The bot stores configuration in `bot-config.json`:

```json
{
  "allowedChannelId": null,
  "prefix": "!",
  "adminUsers": [],
  "adminRoleIds": []
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `allowedChannelId` | string \| null | Channel ID to restrict bot to |
| `prefix` | string | Command prefix (default: `!`) |
| `adminUsers` | string[] | User IDs with admin privileges |
| `adminRoleIds` | string[] | Role IDs with admin privileges |

### Admin Detection

Users are considered admins if they:
1. Are in the `adminUsers` list
2. Have a role in `adminRoleIds`
3. Are the server owner
4. Have a role with `ManageServer`, `ManageRoles`, or `GrantAll` permission

## File Upload

Compiled binaries are uploaded via:

1. **Stoat Autumn** (preferred) - Direct attachment to message
2. **Vikingfile** (fallback) - External file host when Stoat blocks the file type

The bot automatically zips binaries and adds a random 8-character suffix to prevent conflicts.

## Project Structure

```
stoat-compiler-bot/
├── src/
│   └── index.ts          # Main bot code
├── Dockerfile            # Compiler container definition
├── package.json          # Node.js dependencies
├── tsconfig.json         # TypeScript configuration
├── .env                  # Environment variables (create this)
├── bot-config.json       # Bot configuration (auto-generated)
└── README.md             # This file
```

## Development

### Scripts

```bash
pnpm run dev      # Development with tsx
pnpm run build    # Compile TypeScript
pnpm start        # Run compiled code
```

### Adding New Languages

1. Add the language to `INTERPRETED_LANGUAGES` or `BUILD_TARGETS`
2. Add dangerous patterns to `detectDangerousPatterns()`
3. Update the Dockerfile if new tools are needed
4. Rebuild the container image

## Troubleshooting

### "Interpreter not found" Error

The container image may be outdated. Rebuild it:

```bash
podman build -t stoat-compiler:latest .
```

### File Upload Failed

The Stoat server may block certain file types. The bot automatically falls back to external hosting via vikingfile.com.

### Permission Denied Errors

Ensure the user running the bot has permission to use Podman:

```bash
# Add user to podman group (Linux)
sudo usermod -aG podman $USER
```

### Container Not Found

Verify the container image exists:

```bash
podman images stoat-compiler:latest
```

## Known Issues

### Message Editing in stoat.js

The `message.edit()` method in stoat.js returns success but may not reflect changes on the server. The bot works around this by deleting and resending messages.

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Acknowledgments

- [Stoat](https://github.com/stoatChat/stoat) - The chat platform this bot is designed for
- [stoat.js](https://www.npmjs.com/package/stoat.js) - The API library used
- [Revolt](https://revolt.chat) - The original platform Stoat is forked from
