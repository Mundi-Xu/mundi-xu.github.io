# 下载源码

安装depot-tools后下载源码

```bash
# 安装depot-tools
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH=`pwd`/depot_tools:"$PATH"
# 下载pdfium
mkdir repo
cd repo
gclient config --unmanaged https://pdfium.googlesource.com/pdfium.git
gclient sync
cd pdfium
```

# 编译

ubuntu 或者 Debian 系统可直接使用 `./build/install-build-deps.sh`安装依赖（不是的可以加上`--unsupported`试试，或者手动配置依赖），利用`gn args out/afl`生成编译参数文件，参考如下

```ini
# Build arguments go here.
# See "gn args <out_dir> --list" for available build arguments.
use_goma = false # Googlers only. Make sure goma is installed and running first.
is_debug = false  # Enable debugging features.

pdf_use_skia = true # Set true to enable experimental skia backend.
pdf_use_skia_paths = false  # Set true to enable experimental skia backend (paths only).

pdf_enable_xfa = true  # Set false to remove XFA support (implies JS support).
pdf_enable_v8 = true  # Set false to remove Javascript support.
pdf_is_standalone = true  # Set for a non-embedded build.
is_component_build = false # Disable component build (must be false)
v8_static_library = true

clang_use_chrome_plugins = false  # Currently must be false.
use_sysroot = false  # Currently must be false on Linux, but entirely omitted on windows.

use_afl = true
is_asan = true
optimize_for_fuzzing = true
symbol_level=2
```

> pdfium 源码仓库中没有afl-fuzz 的代码，需要自己下载，当然也可以使用自己魔改过的afl（默认版本为2.52b，推荐使用2.57b)
>
> `https://chromium.googlesource.com/chromium/src/third_party/+/master/afl/ `

使用 `ninja -C out/afl` 编译全部文件，或者使用`ninja -C out/afl <test target>`编译自己想fuzz的目标。

# 开始Fuzz

afl-fuzz 的使用和其他项目一样。初始的种子文件有几个地方可以获取：

- https://pdfium.googlesource.com/pdfium/+/refs/heads/master/testing/resources/
- https://github.com/mozilla/pdf.js/tree/master/test/pdfs

```shell
./afl-fuzz -M 01 -m none -t 30000 -i /home/fuzz/input -o /home/fuzz/out -x /home/fuzz/pdf.dict -- ./pdfium_test @@
```

# libjpeg-turbo编译与fuzz

> `https://github.com/libjpeg-turbo/libjpeg-turbo`

`libjpeg-turbo`是pdfium中默认的JPEG编解码器

AFL插桩编译：

```shell
mkdir build && cd build && cmake -DCMAKE_C_COMPILER=afl-clang-fast -DCMAKE_C_FLAGS="-g -fsanitize=address" ..
CC=afl-clang-fast CXX=afl-clang-fast++ AFL_USE_ASAN=1 make
```

以`cjpeg`为例选择目标进行fuzz：

```shell
afl-fuzz -M 1 -i ../seed-corpora/afl-testcases/bmp/ -o fuzzout -m none -t 60000  -x ~/AFLplusplus/dictionaries/bmp.dict  -- ./cjpeg-static -quality 95 -dct float -rgb -optimize  -outfile ./1.jpg @@
```

# 代码覆盖率测试

> `https://github.com/mrash/afl-cov.git`

```shell
 cmake  -DCMAKE_C_FLAGS="-g -fprofile-arcs -ftest-coverage" -DCMAKE_CXX_FLAGS="-g  -fprofile-arcs -ftest-coverage" ..
 make -j8

~/afl-cov/afl-cov -d ../build/jpegout/ --live --coverage-cmd "./jpegtran-static -progess AFL_FILE" --code-dir . --enable-branch-coverage --overwrite

```
