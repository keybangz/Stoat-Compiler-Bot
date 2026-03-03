# Stoat Compiler Image - Multi-Language Support
# Build: podman build -t stoat-compiler:latest .

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install C/C++ compilers, Rust, and interpreted languages
RUN apt-get update && apt-get install -y \
    # Build essentials
    build-essential \
    make \
    file \
    curl \
    # C/C++ compilers for cross-compilation
    gcc g++ \
    gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
    mingw-w64 \
    # Interpreted languages
    python3 python3-pip \
    nodejs npm \
    ruby \
    perl \
    && rm -rf /var/lib/apt/lists/*

# Configure MinGW to use POSIX threads (required for C++11+ threading)
RUN update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix \
    && update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Add Rust cross-compilation targets
RUN rustup target add x86_64-unknown-linux-gnu \
    && rustup target add aarch64-unknown-linux-gnu \
    && rustup target add x86_64-pc-windows-gnu

# Install Rust cross-compilation linker for ARM64
RUN apt-get update && apt-get install -y gcc-aarch64-linux-gnu && rm -rf /var/lib/apt/lists/*

# Configure Cargo for cross-compilation
RUN mkdir -p /root/.cargo && echo '[target.aarch64-unknown-linux-gnu]\nlinker = "aarch64-linux-gnu-gcc"\n\n[target.x86_64-pc-windows-gnu]\nlinker = "x86_64-w64-mingw32-gcc"\nar = "x86_64-w64-mingw32-gcc-ar"' > /root/.cargo/config.toml

# Create directories for mounted source/output
RUN mkdir -p /src /output
WORKDIR /src

# Verify all compilers work
RUN echo 'int main(){return 0;}' > test.cpp && \
    g++ -static test.cpp -o test_linux && \
    aarch64-linux-gnu-g++ -static test.cpp -o test_arm64 && \
    x86_64-w64-mingw32-g++ -static test.cpp -o test_windows.exe && \
    rm -f test.cpp test_linux test_arm64 test_windows.exe

# Verify Rust works
RUN echo 'fn main(){println!("Hello");}' > test.rs && \
    rustc test.rs -o test_rust && \
    rm -f test.rs test_rust

# Verify interpreted languages work
RUN echo 'print("Hello")' > test.py && python3 test.py && rm -f test.py
RUN echo 'console.log("Hello")' > test.js && node test.js && rm -f test.js
RUN echo 'puts "Hello"' > test.rb && ruby test.rb && rm -f test.rb
RUN echo 'print "Hello\n"' > test.pl && perl test.pl && rm -f test.pl
