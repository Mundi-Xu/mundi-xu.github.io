# 前言

`American Fuzzy Lop plus plus (afl++)`是一个由社区驱动的开源工具，它结合了最新的模糊研究，使研究具有可比性，可重复性，可组合性，并且-最重要的是-**可用的** 。它提供了多种新功能，例如，`Custom Mutator API` （传统的突变API）能够**增加模糊测试处理策略**，**特定目标的变异**也可以由经验丰富的安全测试人员编写。具体细节可以参阅[AFL++ : Combining Incremental Steps of Fuzzing Research](https://www.usenix.org/conference/woot20/presentation/fioraldi)。

本文主要介绍如何使用AFL++快速开始Fuzz一个样例程序和对大量的Fuzzer-Generated Crashes进行分类以及部分工具的安装与使用，如有错漏，也请师傅们不吝赐教。

# AFL++的安装

> American Fuzzy Lop plus plus (afl++)
> Release Version: 3.14c
> Github Version: 3.15a
> Repository: https://github.com/AFLplusplus/AFLplusplus
> Doc: https://aflplus.plus/

最简单的当然就是使用Docker啦，直接一键pull就可以使用了，具体请参见[Dockerfile](https://github.com/AFLplusplus/AFLplusplus/blob/stable/Dockerfile)(一般情况下都够用了)

```shell
docker pull aflplusplus/aflplusplus
docker run -ti -v /location/of/your/target:/src aflplusplus/aflplusplus
```

或者手动安装依赖后下载源码编译构建。（建议下载最新版本的编译器）

```shell
sudo apt-get install git build-essential curl libssl-dev sudo libtool libtool-bin libglib2.0-dev bison flex automake python3 python3-dev python3-setuptools libpixman-1-dev gcc-9-plugin-dev cgroup-tools \
clang-12 clang-tools-12 libc++-12-dev libc++1-12 libc++abi-12-dev libc++abi1-12 libclang-12-dev libclang-common-12-dev libclang-cpp12 libclang-cpp12-dev libclang1-12 liblld-12 liblld-12-dev liblldb-12 liblldb-12-dev libllvm12 libomp-12-dev libomp5-12 lld-12 lldb-12 llvm-12 llvm-12-dev llvm-12-linker-tools llvm-12-runtime llvm-12-tools python3-lldb-12
```

有时你可能需要切换下软件的默认版本。

```shell
sudo update-alternatives --install /usr/bin/clang clang `which clang-12` 0
sudo update-alternatives --install /usr/bin/clang++ clang++ `which clang++-12` 0
sudo update-alternatives --install /usr/bin/llvm-config llvm-config `which llvm-config-12` 0
sudo update-alternatives --install /usr/bin/llvm-symbolizer llvm-symbolizer `which llvm-symbolizer-12` 0
```

获取源码并编译安装。

```shell
git clone https://github.com/AFLplusplus/AFLplusplus
cd AFLplusplus
git checkout stable # 选择安装版本，默认为stable
make distrib # 安装包括qemu_mode, unicorn_mode等在内的所有模式
sudo make install
```

make构建目标选择：

+ all: just the main AFL++ binaries
+ binary-only: everything for binary-only fuzzing: qemu_mode, unicorn_mode, libdislocator, libtokencap
+ source-only: everything for source code fuzzing: instrumentation, libdislocator, libtokencap
+ distrib: everything (for both binary-only and source code fuzzing)
+ man: creates simple man pages from the help option of the programs
+ install: installs everything you have compiled with the build options above
+ clean: cleans everything compiled, not downloads (unless not on a checkout)
+ deepclean: cleans everything including downloads
+ code-format: format the code, do this before you commit and send a PR please!
+ tests: runs test cases to ensure that all features are still working as they should
+ unit: perform unit tests (based on cmocka)
+ help: shows these build options

构建选项：

+ STATIC - compile AFL++ static
+ ASAN_BUILD - compiles with memory sanitizer for debug purposes
+ DEBUG - no optimization, -ggdb3, all warnings and -Werror
+ PROFILING - compile with profiling information (gprof)
+ INTROSPECTION - compile afl-fuzz with mutation introspection
+ NO_PYTHON - disable python support
+ NO_SPLICING - disables splicing mutation in afl-fuzz, not recommended for normal fuzzing
+ AFL_NO_X86 - if compiling on non-intel/amd platforms
+ LLVM_CONFIG - if your distro doesn't use the standard name for llvm-config (e.g. Debian)

安装完成后的系统配置：

```shell
sudo ~/AFLplusplus/afl-system-config #将降低系统的安全性，建议仅在docker中使用
ulimit -c 0 # 当程序crash时不产生core文件，在存在大量crashes的时候特别有用
```

# 开始Fuzzing

相信很多人在刚开始的时候都会有下面两个问题（包括我）
1. 不熟悉模糊测试工具；
2. 用模糊测试测试什么内容

对于第一点，建议参阅[FuzzingBook](https://www.fuzzingbook.org/)和Sakura师傅的[AFL源码注释](https://www.anquanke.com/post/id/213430)，至于第二个，我建议的选择是类似于afl-training或者EkoParty_Advanced_Fuzzing_Workshop等学习类型的target，也是本系列文章的主要内容部分（后续实战目标的选择可以看我的博客）。

> Fuzzing with AFL workshop
> Repository: https://github.com/mykter/afl-training
> Doc: https://github.com/mykter/afl-training/files/5454345/Fuzzing.with.AFL.-.GrayHat.2020.pdf
> Docker: https://ghcr.io/mykter/fuzz-training

测试代码可以在此[下载](https://raw.githubusercontent.com/mykter/afl-training/main/quickstart/vulnerable.c)，核心函数代码如下：

```c
int process(char *input)
{
	char *out;
	char *rest;
	int len;
	if (strncmp(input, "u ", 2) == 0)
	{ // upper case command
		char *rest;
		len = strtol(input + 2, &rest, 10); // how many characters of the string to upper-case
		rest += 1;							// skip the first char (should be a space)
		out = malloc(len + strlen(input));	// could be shorter, but play it safe
		if (len > (int)strlen(input))
			/* skip */
		for (int i = 0; i != len; i++)
		{
			char c = rest[i];
			if (c > 96 && c < 123) // ascii a-z
			{
				c -= 32;
			}
			out[i] = c;
		}
		out[len] = 0;
		strcat(out, rest + len); // append the remaining text
		printf("%s", out);
		free(out);
	}
	else if (strncmp(input, "head ", 5) == 0)
	{ // head command
		if (strlen(input) > 6)
		{
			len = strtol(input + 4, &rest, 10);
			rest += 1;		  // skip the first char (should be a space)
			rest[len] = '\0'; // truncate string at specified offset
			printf("%s\n", rest);
		}
		/* skip */
	}
	else if (strcmp(input, "surprise!\n") == 0)
	{
		// easter egg!
		*(char *)1 = 2;
	}
	/* skip */
}
```

使用afl-clang-fast进行编译，如提示命令未找到就将AFL++目录添加至PATH环境变量。

```shell
afl-clang-fast -AFL_HARDEN=1 vulnerable.c -o vulnerable
```

优先选择更好的插桩方式，若使用afl-cc会自动选择最合适的编译器。

```
+--------------------------------+
| clang/clang++ 11+ is available | --> use LTO mode (afl-clang-lto/afl-clang-lto++)
+--------------------------------+     see [instrumentation/README.lto.md](instrumentation/README.lto.md)
    |
    | if not, or if the target fails with LTO afl-clang-lto/++
    |
    v
+---------------------------------+
| clang/clang++ 3.8+ is available | --> use LLVM mode (afl-clang-fast/afl-clang-fast++)
+---------------------------------+     see [instrumentation/README.llvm.md](instrumentation/README.llvm.md)
    |
    | if not, or if the target fails with LLVM afl-clang-fast/++
    |
    v
 +--------------------------------+
 | gcc 5+ is available            | -> use GCC_PLUGIN mode (afl-gcc-fast/afl-g++-fast)
 +--------------------------------+    see [instrumentation/README.gcc_plugin.md](instrumentation/README.gcc_plugin.md) and
                                       [instrumentation/README.instrument_list.md](instrumentation/README.instrument_list.md)
    |
    | if not, or if you do not have a gcc with plugin support
    |
    v
   use GCC mode (afl-gcc/afl-g++) (or afl-clang/afl-clang++ for clang)

```

设置AFL_HARDEN会让调用的下游编译器自动化代码加固，使得检测简单的内存bug变得更加容易，但会减少5%左右的性能，关于AFL++的环境变量设置可以参阅https://aflplus.plus/docs/env_variables/。

使用afl-fuzz进行Fuzz，输入可以随意写，如`echo 1 > inputs/1`，或带有源码中关键字的输入（推荐），如`echo "u 4 capsme" > inputs/2`，但需保证输入必须能使程序正常运行（即不能一开始就整个crash）。

```shell
mkdir inputs
mkdir out
echo 1 > inputs/1
echo "u 4 capsme" > inputs/2
afl-fuzz -i inputs -o out ./vulnerable
```

如果一切正常的话，睡个午觉之后你就能看见类似于如下的图：

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/quickstart.png)

每个独特的crash和命令参数都将存放在输出文件夹的crashes文件夹下，接下来就是对这些crash进行调试分析了。

# crashes分类与自动化分析

在开始分析前请确保已安装gdb等常用二进制调试工具，我使用的是GDB的[gef插件](https://github.com/hugsy/gef)。

对crashes的分类包括调试分析Fuzz程序发现的每个crash以确定碰撞是否值得进一步分析（对安全研究人员而言，这通常意味着确定crash是否可能是由漏洞造成的），如果是，则确定crash的根本原因。详细地人工分析每一个crash都非常耗时耗力，尤其当Fuzzer已经识别出几十次或上百次crash时。

幸运的是现在已有许多可用于帮助分类或分析crash的技术和工具。虽然crashes的分类仍然可能是一个痛苦的过程，但下述的工具可以帮助减轻一些乏味的工作，至少也能大概确定最有可能触发安全相关问题的crash优先级。

## crash复现与初步分析

首先我们来看看刚才得到的九个crash（这里只有八个的原因是我服务器崩了导致我重跑了一遍，但第九个crash怎么也出不来。。。。。。。。）

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310160024060.png)

我们先用gdb简单调试下：

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310161229664.png)

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310161327761.png)

显然，我们能知道错误类型（在这种情况下为SIGSEV），发生错误的代码行（因为二进制文件是带调试信息编译的），造成崩溃的指令（`movdqu xmm2, XMMWORD PTR [r13+rdi*1+0x11]`，大概率是因为非法访问内存），backtrace以及其他诸如stack内容等信息。但逐个这样分析crash是一件很费时费力的工作，所以我们需要一些自动化工具来帮助我们进行分析。

## 自动化工具的介绍和使用

> GDB 'exploitable' plugin
> Repository: https://github.com/jfoote/exploitable

exploitable是一个gdb插件，安装请参见安装文档，它试图确定某个特定的crash是否可能可以被利用。该插件为各类程序状态提供了一系列的分类标准，如果程序处于可以被插件识别的状态，它将为该状态分配可利用性的分类。使用如下：

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310163220227.png)

此工具可以帮助用户优先分析那些最有可能被利用的crash，不太可能被利用的（或者插件无法分析的）可能仍然值得分析，但这是在调试了那些更有希望发现漏洞的crash之后。

---

> crashwalk
> Repository: https://github.com/bnagy/crashwalk
> Doc: https://pkg.go.dev/github.com/bnagy/crashwalk

Crashwalk是在exploitable插件基础上开发的一款工具。Crashwalk将遍历AFL生成的crashes并在crash状态下运行exploitable并生成一个crashwalk.db文件。

使用方法：

```shell
export CW_EXPLOITABLE=/path/to/exploitable.py
./cwtriage -root ./out/default/crashes/ -match id -- ./vulnerable
```

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310164846659.png)

使用cwdump获取摘要：

```shell
./cwdump ./crashwalk.db
```

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310165705086.png)

---

> afl-utils
> Repository: https://gitlab.com/rc0r/afl-utils
> Docs: https://gitlab.com/rc0r/afl-utils/-/tree/master/docs

含有一系列协助Fuzzing的工具集合：

+ 自动crash样本收集，验证，过滤和分析（`afl-collect`，`afl-vcrash`）
+ 轻松管理并行（多核）Fuzz测试作业（`afl-multicore`，`afl-multikill`）
+ 语料库优化（`afl-minimize`）
+ Fuzz状态统计监督（`afl-stats`）
+ Fuzzer队列同步（`afl-sync`）
+ 自主实用程序执行（`afl-cron`）

其中afl-collect与crashwalk类似，也可调用exploitable进行简单分析并生成库，具体上篇文章已经介绍过了，不再赘述，直接上图：

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310180108989.png)

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310180131008.png)

可以看出afl-collect很快就统计了脚本数据并将crashes整合后复制到了输出文件夹，对比crashwalk的结果而言简明了很多。但需要注意的是，exploitable并没有考虑在现有防御机制下漏洞的利用难度，所以我们还需要使用下述工具来辅助我们进行分析。

---

> AFL crash exploration mode
> Repository: https://github.com/AFLplusplus/AFLplusplus#help-crash-triage
> Reference: https://lcamtuf.blogspot.com/2014/11/afl-fuzz-crash-exploration-mode.html

这是一种内置于AFL中的模式，Fuzzer将一个或多个导致crash的测试用例作为输入，并使用其feedback-driven fuzzing策略在保持crash的情况下快速枚举程序中可以到达的所有代码路径。

一般而言，我们希望Fuzzer找到更多独特的crash而不是一次又一次的同类crashes。然而，正如文档中所指出的，这种模式的目的是创建一个小的crashes库从而可以快速地检查它来分析我们对漏洞的控制程度。例如，如果crash与写入地址有关，但我们无法控制该地址，那么这个就可能不是那么有用。另一方面，如果AFL的crash exploration模式确定我们可以通过更改输入来对任意地址执行写操作，那么我们就更有可能利用这个漏洞进行攻击。

我们将使用afl-fuzz生成的初始崩溃用例来启用崩溃探索模式，即将crashes目录作为输入并使用`-C`运行afl-fuzz：

```shell
afl-fuzz -C -i out/default/crashes/ -o crash_exploration/ ./vulnerable
```

当AFL开始以这种模式运行时，它将检查测试用例以确保它们导致crash，如下所示：

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310172512489.png)

在AFL的正常模式中，此步骤的目的是对测试用例进行检查以确保它们**不会**导致崩溃。AFL希望使用正常的测试文件来使程序按预期方式运行，以便可以对它们进行迭代以触发异常行为。相反，崩溃探索模式确保这些测试用例已经导致crash，因为它将尝试识别将导致相同状态的其他代码路径。

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210310172616236.png)

---

> Record and Replay Framework
> Repository: https://github.com/rr-debugger/rr
> Doc: https://rr-project.org/
> Wiki: https://github.com/rr-debugger/rr/wiki
> Reference: [Engineering Record And Replay For Deployability Extended Technical Report](https://arxiv.org/pdf/1705.05937.pdf)

需要Linux内核3.11或更高版本且`/proc/sys/kernel/perf_event_paranoid`必须小于等于1（即能够使用`perf`计数器）。详细要求请参阅`https://github.com/rr-debugger/rr/wiki/Building-And-Installing#hardwaresoftware-configuration` 。我的服务器不符合要求，就在这里仅做个介绍推荐吧，有空再补（咕了

# 对crash的简单调试

让我们从上面分完类的crashes中随机挑一个丢到gdb里去，在`strcat(out, rest + len);`处下个断点（当然在其他地方也可以，主要是这里的溢出点太明显了。。。。）

![heap-view](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/heap-view.png)

可以看出来在执行strcat函数之前的堆还是十分正常的

![heap-chunks](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/heap-chunks.png)

oops,溢出啦，让我们来看一下输入文件的内容

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/xxd.png)

显然是因为strcat造成溢出覆盖了top chunk，然后在printf调用malloc的时候触发crash。而输入我们是可以自定义的，也就是说我们现在可以控制top chunk的size了，接下来的利用过程就交给各位师傅们了。

![](https://cdn.jsdelivr.net/gh/Mundi-Xu/picture_resource@master/picture/AFL++学习日志（一）开始Fuzz与crashes分析/image-20210312161833139.png)

# 总结

在本文中我们介绍了AFL++的安装和各类工具的使用以帮助我们对Fuzzer生成的crashes进行分类与分析。当然，还有很多自动化分析工具没有介绍，具体可以参阅`https://aflplus.plus/docs/sister_projects/#crash-triage-coverage-analysis-and-other-companion-tools`。 

在下篇文章中我会学着如何对一些简单的库代码和真实软件编写harness来帮助Fuzzer更好地进行Fuzzing。

