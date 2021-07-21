# 介绍

本系列文章笔者将简单介绍Chrome V8的整体模型与其主要概念和数据结构，希望能对读者理解浏览器安全相关产生帮助。

# 基本概念

Google Chrome的大致架构如下，V8主要包含堆栈的内存管理

```
+------------------------------------------------------------------------------------------+
| Google Chrome                                                                            |
|                                                                                          |
| +----------------------------------------+          +------------------------------+     |
| | Google V8                              |          |            WebAPIs           |     |
| | +-------------+ +---------------+      |          |                              |     |
| | |    Heap     | |     Stack     |      |          |                              |     |
| | |             | |               |      |          |                              |     |
| | |             | |               |      |          |                              |     |
| | |             | |               |      |          |                              |     |
| | |             | |               |      |          |                              |     |
| | |             | |               |      |          |                              |     |
| | +-------------+ +---------------+      |          |                              |     |
| |                                        |          |                              |     |
| +----------------------------------------+          +------------------------------+     |
|                                                                                          |
|                                                                                          |
| +---------------------+     +---------------------------------------+                    |
| |     Event loop      |     |          Task/Callback queue          |                    |
| |                     |     |                                       |                    |
| +---------------------+     +---------------------------------------+                    |
|                             +---------------------------------------+                    |
|                             |          Microtask queue              |                    |
|                             |                                       |                    |
|                             +---------------------------------------+                    |
|                                                                                          |
|                                                                                          |
+------------------------------------------------------------------------------------------+
```

## 内存机制

在Chrome V8中，内存机制是非常重要的，V8是一个使用C++完成的库，用于执行JavaScript，如果你在自己的JavaScript代码中声明了一个变量，那么这个变量将由V8的内存机制进行管理，且只能由它的内存回收机制所回收，而不能被我们自己进行管理（不能被delete或者free等操作符操作）。

Chrome V8中的堆内存大致可分为以下部分：

+ 新生代内存区：基本的数据对象都被分配在这里，其区域小但是回收频繁。
+ 老生代指针区：一堆指向老生代内存区具体数据内容的指针，基本上从新生代进化过来的对象会被移动到此。
+ 老生代数据区：存放数据对象而不是指向其他对象的指针，老生代指针区的指针就往这边指。
+ 大对象区：这里存放体积超越其他区大小的对象，每个对象由自己的内存，GC并不会移动大对象。
+ 代码区：代码对象，也就是包含JIT之后指令的对象，会被分配在这里，也是唯一拥有执行权限的内存区。
+ Cell区，属性Cell区，Map区：存放Cell，属性Cell和Map，每个区域都是存放相同大小的元素，结构简单。

```
+----------------------- -----------------------------------------------------------+
|   Young Generation                  Old Generation          Large Object space    |
|  +-------------+--------------+  +-----------+-------------+ +------------------+ |
|  |        NEW_SPACE           |  | MAP_SPACE | OLD_SPACE   | | LO_SPACE         | |
|  +-------------+--------------+  +-----------+-------------+ +------------------+ |
|  |  from_Space   | to_Space   |                                                   |
|  +-------------+--------------+                                                   |
|  +-------------+                 +-----------+               +------------------+ |
|  | NEW_LO_SPACE|                 | CODE_SPACE|               | CODE_LO_SPACE    | |
|  +-------------+                 +-----------+               +------------------+ |
|                                                                                   |
|   Read-only                                                                       |
|  +--------------+                                                                 |
|  | RO_SPACE     |                                                                 |
|  +--------------+                                                                 |
+-----------------------------------------------------------------------------------+
```

上图中每个堆部分的空间被GC以不同的方式处理，最重要的两部分就是新生代内存和老生代内存的垃圾回收机制。

### 新生代内存

绝大多数JavaScript对象都会被分配到新生代内存中，内存区域很小但是垃圾回收频繁。

在新生代分配内存非常容易，我们只需要保存一个指向内存区的指针并不断根据新对象的大小递增即可。当该指针到达了新生代内存区的末尾时，就会有一次清理。

新生代内存使用Scavenge算法进行回收：

```
ptrs   from_space (evacuation)   to_space
      +----------+            +------------+
----->|marked: * | ---------->|marked: s   |       (s=survived)
      +----------+            +------------+
      |marked:   |      ----->|marked: s   |
      +----------+     /      +------------+
----->|marked: * | ----       |            |
      +----------+            +------------+
      |marked:   |            |            |
      +----------+            +------------+
      |marked:   |            |            |
      +----------+            +------------+
```

该种算法中的大致思想为：将内存一分为二，每部分的空间都被成为`Semispace`。在两个`Semispace`中，总有一个处于使用状态，成为From空间；另一个处于闲置状态，称为To空间。

在分配对象时，总使用From空间进行分配；在垃圾回收时，Chrome V8检查From空间中的存活对象，然后将这些对象复制到To空间中，剩下的对象就会被释放，完成复制后From空间和To空间的角色对调，原来的From空间变成了新的To空间，而原来的To空间就变成了From空间。由此可以看出，在新生代内存中总有至少一半的内存是空闲不用的，不过新生代内存的特点就是空间小，回收频繁，所以也浪费不了多少。

当一个新生代中的对象经过多次新生代的垃圾回收而继续坚挺在内存区中时，说明它的生命周期较长，就会被移动到老生代内存，也称为对象的晋升。

晋升的标准有两条：

+ 在垃圾回收的过程中，如果该对象已经经历过一次新生代的清理，那就会晋升
+ 在垃圾回收的过程中，如果其中To空间的使用已经超过了25%，那么这个对象也会晋升

### 老生代内存

老生代内存所保存的对象大多数是生存周期很长的甚至是常驻内存的对象，而且老生代占用的内存较多，如果这里再使用Scavenge算法进行垃圾回收，那浪费的内存就太大了。

所以GC就采用Mark-Sweep和Mark-Compact的结合体进行垃圾回收，主要采用Mark-Sweep，如果老生代空间不足以分配从新生代晋升过来的对象时，才使用Mark-Compact。

```
 Page 1              FreeList                        Page 1
+----------+        +--------------+		+------------+
|marked: * |---\    |    Size 1    |	--------|marked: s   |
+----------+    \   | +----------+ |   /	+------------+
|marked:   |     ---|>|__________| |  /	       -|marked: s   |
+----------+        | |__________|<|--        /	+------------+
|marked: * |--\     | |__________| |         /	|            |
+----------+   \    |    Size 2    |        /	+------------+
|marked:   |    \   | +----------+ |       /	|            |
+----------+     ---|>|__________|<|-------	+------------+
|marked:   |        | |__________| |		|            |
+----------+        | |__________| |            +------------+
                    +--------------+
```

#### Mark-Sweep（标记清除）

其分为两个阶段：

+ 标记：在标记阶段需要遍历老生代堆中的所有对象，并标记那些活着的对象，然后进入清除阶段。
+ 清除：在清除阶段，Chrome V8只清除没有被标记的对象。

由于Mark-Sweep只清除死亡对象，而死亡对象在老生代中占用的比例通常较小，因此效率还是比较高的。就像从一堆白球中拿出几个红球还是很快的，至少比从一堆白球中拿出半堆红球快得多。

#### Mark-Compact（标记整理）

在Mark-Sweep时，容易产生内存碎片的问题,所以Mark-Compact在标记清除的基础上进行了压缩步骤，在清除时让它们变得紧缩。这相当于在清除的时候，让活着的剩余对象尽可能往内存区域的前面靠，直到内存区域前排全部排满，而后部区域是空的。

Mark-Compact的过程涉及内存区域的紧缩，所以效率比Mark-Sweep要低，不过其优势是不会产生内存碎片。

#### 惰性清理

Chrome V8在标记时就可以了解到哪些对象是死的，哪些对象是活的，但清理释放是需要开销的，所以Chrome V8并不急着去清理，而是延迟进行，GC可以根据需要来清理死掉的对象。

## 隔离实例（Isolate）

在Chrome V8中，一个引擎实例的数据类型叫Isolate，这是Chrome V8中所有要执行的地方都要出现的数据。它就是一个V8引擎的实例，也可以理解为引擎本体。每个实例内部拥有完全独立的各种状态，包括堆管理、垃圾回收等。

通过一个实例生成的任何对象都不能在另一个实例中使用，可以创建多个Isolate实例并且并行的在多个线程中使用，但同一个实例不能在多线程中使用。实例自身并不执行JavaScript，也没有JavaScript环境里面的上下文。

可以通过下述代码创建一个实例：

```c++
// 省略 V8 初始化过程

// 实例所必要的参数
v8::Isolate::CreateParams create_params;

// 省略参数设置过程

// 创建一个实例
v8::Isolate* isolate = v8::Isolate::New(create_params);
```

## 上下文（Context）

上下文是用来定义JavaScript执行环境的一个对象，其数据类型是Context，在创建时要指明属于哪个实例。

```c++
v8::Isolate* isolate = ...;
v8:Local<v8::Context> context = v8::Context::New(isolate);
```

其大致相当于一个沙箱化的执行上下文环境，内部预置了一系列的对象和函数，具体细节将在下篇文章继续探讨。

## 脚本（Script）

顾名思义，脚本就是一个包含一段已经编译好的JavaScript脚本的对象，数据类型就是Script。它在编译时就与一个处于活动状态的Context进行绑定。

```c++
v8::Local<v8::Context> context = ...;

v8::Local<v8::String> source = 一段JavaScript代码；

// 与上下文绑定并编译
v8::Local<v8::Value> result = v8::Script::Compile(context, source).ToLocalChecked();

//执行脚本
v8::Local<v8::Value> result = script->Run(context).ToLocalChecked();
```

# 句柄（Handle）

句柄是Chrome V8中的一个重要概念，它提供了对于堆内存中JavaScript数据对象的一个引用。与对象（Object）相似，Handle也包含一个地址成员（在HandleBase中定义，称为location_），但和对象不同的是句柄充当抽象层的作用，其可以被GC重新定位。

Chrome V8在进行垃圾回收的时候，通常会将JavaScript的数据对象移来移去。和对象指针相比，一旦一个对象被移走，这个指针就成了野指针。而在移动的过程中，GC会更新引用了这个数据块的那些句柄，让其断不了联系。当一个对象不再被句柄引用时，那么它将被认定为垃圾，Chrome V8的垃圾回收机制会不时的对其进行回收。具体细节可以参阅`src/handles/handles.h`

````c++
class HandleBase {  
 ...
 protected:
  Address* location_; 
}
template <typename T>                                                           
class Handle final : public HandleBase {
  ...
}
````



```
+----------+                  +--------+         +---------+
|  Handle  |                  | Object |         |   int   |
|----------|      +-----+     |--------|         |---------|
|*location_| ---> |&ptr_| --> | ptr_   | ----->  |     5   |
+----------+      +-----+     +--------+         +---------+
```



```apl
(gdb) p handle
$8 = {<v8::internal::HandleBase> = {location_ = 0x7ffdf81d60c0}, <No data fields>}
```

location_包含一个指针

```apl
(gdb) p /x *(int*)0x7ffdf81d60c0
$9 = 0xa9d330
```

其值和对象中的一样

```apl
(gdb) p /x obj.ptr_
$14 = 0xa9d330
```

我们可以用指针去访问这个int值

```apl
(gdb) p /x *value
$16 = 0x5
(gdb) p /x *obj.ptr_
$17 = 0x5
(gdb) p /x *(int*)0x7ffdf81d60c0
$18 = 0xa9d330
(gdb) p /x *(*(int*)0x7ffdf81d60c0)
$19 = 0x5
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "src/handles/handles.h"
#include "src/objects/objects-inl.h"

namespace i = v8::internal;

TEST(Handle, DefaultConstructor) {
  i::Handle<int> handle{};
  EXPECT_TRUE(handle.is_null());
  EXPECT_EQ(handle.location(), nullptr);
}

TEST(Handle, AddressConstructor) {
  int* value = new int{5};
  i::Address addr = reinterpret_cast<i::Address>(value);
  i::Object obj{addr};

  i::Address ptr = obj.ptr();
  i::Address* location = &ptr;
  i::Handle<i::Object> handle(location);

  EXPECT_EQ(handle.location(), &ptr);
  EXPECT_EQ(*handle.location(), ptr);
  i::Object deref = *handle;
  i::Address deref_addr = deref.ptr();
  int* deref_value = reinterpret_cast<int*>(deref_addr);
  EXPECT_EQ(*deref_value, *value);
  delete value;
}
```

话说回来，句柄在Chrome V8中只是一个统称，它其实还分为多种类型：

+ 本地句柄(v8::Local)
+ 持久句柄(v8::Persistent)
+ 永生句柄(v8::Eternal)
+ 待实本地句柄(MaybeLocal)
+ 其他句柄

> https://v8.dev/docs/embed

**句柄存在的形式是C++的一个模板类，其需要根据不同的Chrome V8数据类型进行不同的声明。** 例如：

+ `v8::Local<v8::Number>` 本地JavaScript数据类型句柄
+ `v8::Persistent<v8::String>` 持久JavaScript字符串类型句柄

## Local

本地句柄存在于栈内存中，并在对应的析构函数调用时被删除，其生命周期由其所在的句柄作用域（Handle Scope）决定。

含有一个指向T的指针成员

```c++
template <class T> class Local { 
...
 private:
  T* val_
}
```

所以我们可以通过`.方法名`来访问句柄对象的一些方法或通过重载后的`*`和`->`两个操作符得到这个句柄所引用对象的实体指针。

假设我们有一个字符串本地句柄`Local<String> str`，那么就可以有以下调用：

+ `str.IsEmpty()` 句柄对象本身的函数，用于判断这个句柄是否是空句柄。
+ `str->Length()` 通过`->`得到`String*`，而String有一个方法Length可获取字符串长度，所以`str->Length()`是这个句柄所指的字符串实体的长度。

我们同样可以使用As或者Cast函数来将某种数据类型的本地句柄转换成另一种类型的本地句柄，其中As是成员函数，而Cast是静态函数。

```c++
v8::Local<v8::Number> nr = v8::Local<v8::Number>(v8::Number::New(isolate_, 12));
v8::Local<v8::Value> val = v8::Local<v8::Value>::Cast(nr);

v8::Local<v8::Value> val2 = nr.As<v8::Value>();
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "v8_test_fixture.h"

class LocalTest : public V8TestFixture {
};

TEST_F(LocalTest, local) {
  v8::Local<v8::Value> v;
  EXPECT_EQ(true, v.IsEmpty()) << "Default constructed Local should be empty";

  // A Local<T> can be converted into a MaybeLocal<T>
  v8::MaybeLocal<v8::Value> maybe = v8::MaybeLocal<v8::Value>(v);
  EXPECT_TRUE(maybe.IsEmpty());

  // Both -> and * return the value of the local.
  EXPECT_EQ(*v, nullptr);
  EXPECT_EQ(v.operator->(), nullptr);

  // The following can be useful in if statement to add branch for
  // when the local is empty.
  v8::Local<v8::Value> out;
  bool has_value = maybe.ToLocal<v8::Value>(&out);
  EXPECT_FALSE(has_value);

  // Calling ToLocalChecked will crash the process if called on an empty
  // MaybeLocal<T>
  //ASSERT_DEATH(maybe.ToLocalChecked(), "Fatal error");

  const v8::HandleScope handle_scope(isolate_);
  // Example of using Local::Cast:
  v8::Local<v8::Number> nr = v8::Local<v8::Number>(v8::Number::New(isolate_, 12));
  v8::Local<v8::Value> val = v8::Local<v8::Value>::Cast(nr);
  // Example of using As:
  v8::Local<v8::Value> val2 = nr.As<v8::Value>();
  
}
```

## Persistent

持久句柄提供了一个堆内存中声明的JavaScript对象的引用。持久句柄与本地句柄在生命周期上的管理是两种不同的方式。当你认为世界那么大，一个JavaScript对象不应该只存在于当前的HandleScope中，而应该出去看看的时候，就应该对这个JavaScript对象使用持久句柄。

举个简单的例子，Google Chrome中的DOM（Document Object Model）节点们在Chrome V8中就是以持久句柄的形式存在的，它们不局限在某个函数的作用域中。

持久句柄可以使用`PersistentBase::SetWeak`使其变弱，成为一个弱持久句柄。当对一个JavaScript对象的引用只剩下一个弱持久句柄时，Chrome V8的GC就会触发一个callback 。

除弱持久句柄以外，持久句柄还分唯一持久句柄（`v8::UniquePersistent<...>`)和一般持久句柄（`v8::Persistent<...>`)。

+ 唯一持久句柄使用C++的构造函数和析构函数来管理其底层对象的生命周期。
+ 一般持久句柄可以使用它的构造函数来进行创建，但是必须调用`Persistent::Reset`来进行显式的清除。

所以一个persistent object是怎么创建的呢？让我们用下述代码来研究研究：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "v8_test_fixture.h"
#include "src/objects/objects.h"
#include "src/objects/slots-inl.h"
#include "src/api/api-inl.h"

extern void _v8_internal_Print_Object(void* object);

class PersistentTest : public V8TestFixture {
};

class Something {
 public:
  Something(v8::Isolate* isolate, v8::Local<v8::Object> obj);
  v8::Persistent<v8::Object>& persistent();
  void make_weak();

 private:
  v8::Persistent<v8::Object> persistent_handle_;
};

Something::Something(v8::Isolate* isolate,
                     v8::Local<v8::Object> obj) : persistent_handle_(isolate, obj) {
}

v8::Persistent<v8::Object>& Something::persistent() {
  return persistent_handle_;
}

void WeakCallback(const v8::WeakCallbackInfo<Something>& data) {
  Something* obj = data.GetParameter();
  std::cout << "in make weak callback..." << '\n';
}

void WeakCallbackVoid(const v8::WeakCallbackInfo<void>& data) {
  Something* obj = reinterpret_cast<Something*>(data.GetParameter());
  //std::cout << "in make weak callback..." << '\n';
}

void Something::make_weak() {
  /*
  auto cb = [](const v8::WeakCallbackInfo<Something>& data) {
        Something* obj = data.GetParameter();
        std::cout << "in make weak callback..." << '\n';
  };
  */
  typedef typename v8::WeakCallbackInfo<Something>::Callback Something_Callback;
  Something_Callback something_callback = WeakCallback;

  typedef typename v8::WeakCallbackInfo<void>::Callback v8_Callback;
  //#if defined(__GNUC__) && !defined(__clang__)
   // #pragma GCC diagnostic push
    //#pragma GCC diagnostic ignored "-Wcast-function-type"
  //#endif
    v8_Callback cb = reinterpret_cast<v8_Callback>(WeakCallbackVoid);
    //persistent_handle_.SetWeak(this, WeakCallback, v8::WeakCallbackType::kParameter);
  //#if defined(__GNUC__) && !defined(__clang__)
    //#pragma GCC diagnostic pop
  //#endif

}

TEST_F(PersistentTest, object) {
  const v8::HandleScope handle_scope(V8TestFixture::isolate_);
  v8::Handle<v8::Context> context = v8::Context::New(isolate_,
                                         nullptr,
                                         v8::Local<v8::ObjectTemplate>());
  v8::Context::Scope context_scope(context);
  v8::Local<v8::Object> object = v8::Object::New(isolate_);
  Something s(isolate_, object);
  s.make_weak();
  EXPECT_EQ(false, s.persistent().IsEmpty()) << "Default constructed Local should be empty";
}

TEST_F(PersistentTest, PrintObject) {
  const v8::HandleScope handle_scope(isolate_);
  v8::Isolate::Scope isolate_scope(isolate_);
  v8::Handle<v8::Context> context = v8::Context::New(isolate_,
                                         nullptr,
                                         v8::Local<v8::ObjectTemplate>());
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Object> obj = v8::Object::New(isolate_);
  //v8::internal::Object** ppo = ((v8::internal::Object**)(*obj));
  //_v8_internal_Print_Object(*ppo);
  _v8_internal_Print_Object(*((v8::internal::Object**)*obj));

  v8::internal::Handle<v8::internal::Object> h = v8::Utils::OpenHandle(*obj); 
  _v8_internal_Print_Object((v8::internal::Address*)h->ptr());

  v8::internal::Object o = *h;
  v8::internal::ObjectSlot slot(h->ptr());
  v8::internal::Address a = slot.address();

  _v8_internal_Print_Object((v8::internal::Address*)v8::Utils::OpenHandle(*obj)->ptr());
}
```

编译

```bash
$ make ./persistent-object_test
$ ./persistent-object_test --gtest_filter=PersistentTest.value
```

与Local不同的是，持久句柄通常是通过Local升级而成，所以它通常是在构造函数中传入一个本地句柄。持久句柄的构造函数有几种常用的重载。

+ `Persistent()` 直接创建一个持久句柄，这种方法获得的持久句柄通常会在后续再调用别的方法对一个本地句柄进行升级。
+ `Persistent(Isolate *isolate, Local<T> that)` 传入Isolate实例以及一个本地句柄，能得到这个本地句柄所引用的Chrome V8数据对象的一个持久句柄。

```c++
Local<Number> local = Number:New(isolate, 2333);
Persistent<Number> persistent_handle(isolate, local);
```

所以为了创建一个持久句柄，我们需要先创建一个Local

```c++
Local<Object> o = Local<Object>::New(isolate_, Object::New(isolate_));
```

`Local<Object>::New`能在`src/api/api.cc`中找到：

```c++
Local<v8::Object> v8::Object::New(Isolate* isolate) {
  i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
  LOG_API(i_isolate, Object, New);
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(i_isolate);
  i::Handle<i::JSObject> obj =
      i_isolate->factory()->NewJSObject(i_isolate->object_function());
  return Utils::ToLocal(obj);
}
```

首先将公有Isolate指针转换成指向内部类型的指针，LOG_API定义在`src\api\api-macros.h`中：

```c++
#define LOG_API(isolate, class_name, function_name)                        \
  RCS_SCOPE(isolate,                                                       \
            i::RuntimeCallCounterId::kAPI_##class_name##_##function_name); \
  LOG(isolate, ApiEntryCall("v8::" #class_name "::" #function_name))
```

LOG是定义在`src/log.h`中的宏：

```c++
#define LOG(isolate, Call)                                 \
  do {                                                     \
    if (v8::internal::FLAG_log) (isolate)->logger()->Call; \
  } while (false)
```

ENTER_V8_NO_SCRIPT_NO_EXCEPTION在`src\api\api-macros.h`中

```c++
#define ENTER_V8_NO_SCRIPT_NO_EXCEPTION(isolate) \
  i::VMState<v8::OTHER> __state__((isolate));
```

VMState做记录与分析用，StateTag表示VM的可能状态，logger维护着状态的一个堆栈。

```c++
template <StateTag Tag>
class VMState {
 public:
  explicit inline VMState(Isolate* isolate);
  inline ~VMState();

 private:
  Isolate* isolate_;
  StateTag previous_tag_;
};
```

## Eternal

一般认为这种句柄在程序的整个生命周期内是不会被删除的。比起持久句柄来说，永生句柄的开销更小（因为不需要垃圾回收），通常用不到，不再赘述。

```c++
template <class T> class Eternal {
 public:
  V8_INLINE Eternal() : val_(nullptr) {}
  template <class S>
  V8_INLINE Eternal(Isolate* isolate, Local<S> handle) : val_(nullptr) {
    Set(isolate, handle);
  }
  // Can only be safely called if already set.
  V8_INLINE Local<T> Get(Isolate* isolate) const;
  V8_INLINE bool IsEmpty() const { return val_ == nullptr; }
  template<class S> V8_INLINE void Set(Isolate* isolate, Local<S> handle);

 private:
  T* val_;
};
```

## MaybeLocal

```c++
template <class T>
class MaybeLocal {
 public:
  V8_INLINE MaybeLocal() : val_(nullptr) {}
  template <class S>
  V8_INLINE MaybeLocal(Local<S> that)
      : val_(reinterpret_cast<T*>(*that)) {
    static_assert(std::is_base_of<T, S>::value, "type check");
  }

  V8_INLINE bool IsEmpty() const { return val_ == nullptr; }

  /**
   * Converts this MaybeLocal<> to a Local<>. If this MaybeLocal<> is empty,
   * |false| is returned and |out| is left untouched.
   */
  template <class S>
  V8_WARN_UNUSED_RESULT V8_INLINE bool ToLocal(Local<S>* out) const {
    out->val_ = IsEmpty() ? nullptr : this->val_;
    return !IsEmpty();
  }

  /**
   * Converts this MaybeLocal<> to a Local<>. If this MaybeLocal<> is empty,
   * V8 will crash the process.
   */
  V8_INLINE Local<T> ToLocalChecked();

  /**
   * Converts this MaybeLocal<> to a Local<>, using a default value if this
   * MaybeLocal<> is empty.
   */
  template <class S>
  V8_INLINE Local<S> FromMaybe(Local<S> default_value) const {
    return IsEmpty() ? default_value : Local<S>(val_);
  }

 private:
  T* val_;
};
```

在旧版本Chrome V8中，如下代码为例：

```c++
Local<Value> x = some_value;
Local<String> s = x.ToString();
s->Anything();
```

在此段代码中，如果ToString()函数内部发生异常时，s将会是一个空的本地句柄，这时执行`s->Anything()`就会导致程序崩溃。所以，我们需要加一个`if(!s.IsEmpty())`判断才能保证程序的健壮性。但实际上有些数据类型的句柄并不需要检查IsEmpty，所以在旧版中可能返回空句柄的那些接口如今都会以MaybeLocal的形式来代替返回值，需要调用`ToLocalChecked`函数来拿到真正的本地句柄。

> MaybeLocal只是为了让你知道哪些地方的返回值需要检查是否为空，而不是确定一定不会返回空。若待实本地句柄为空，直接转换成Local还是会抛出异常。

```c++
MaybeLocal<String> s = x.ToString();

if(!s.IsEmpty()){
    Local<String> _s = s.ToLocalChecked();
}
```

样例代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8_test_fixture.h"
#include "v8.h"

using namespace v8;

class MaybeLocalTest : public V8TestFixture {
};

TEST_F(MaybeLocalTest, Basic) {
  Isolate::Scope isolate_scope(isolate_);
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  MaybeLocal<Value> m;
  EXPECT_TRUE(m.IsEmpty());
  ASSERT_DEATH(m.ToLocalChecked(), "Fatal error");

  // the {} will use the types, MaybeLocal default constructor so this would
  // be the same as writing MaybeLocal<Value> something = MaybeLocal<Value>();
  MaybeLocal<Value> something = {};
  EXPECT_TRUE(something.IsEmpty());
  MaybeLocal<Value> something2 = MaybeLocal<Value>();
  EXPECT_TRUE(something2.IsEmpty());
}

TEST_F(MaybeLocalTest, ToLocal) {
  Isolate::Scope isolate_scope(isolate_);
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  Local<Number> nr = Number::New(isolate_, 18);
  MaybeLocal<Number> maybe_nr = MaybeLocal<Number>(nr);
  EXPECT_FALSE(maybe_nr.IsEmpty());

  Local<Number> nr2;
  // The following pattern can be nice to use with if statements
  // since ToLocal returns a bool if the MaybeLocal is empty.
  EXPECT_TRUE(maybe_nr.ToLocal<Number>(&nr2));
  EXPECT_TRUE(maybe_nr.ToLocal(&nr2));
  EXPECT_EQ(nr2->Value(), 18);
}

TEST_F(MaybeLocalTest, FromMaybe) {
  Isolate::Scope isolate_scope(isolate_);
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  Local<String> str = String::NewFromUtf8Literal(isolate_, "bajja");
  MaybeLocal<String> maybe_str = MaybeLocal<String>(str);
  Local<Value> from_local = maybe_str.FromMaybe<Value>(Local<Value>());
  EXPECT_FALSE(from_local.IsEmpty());
  String::Utf8Value value(isolate_, from_local);
  EXPECT_STREQ("bajja", *value);

  maybe_str = MaybeLocal<String>();
  from_local = maybe_str.FromMaybe<Value>(Local<Value>());
  EXPECT_TRUE(from_local.IsEmpty());
}

MaybeLocal<Value> something() {
  MaybeLocal<Object> empty; // call some function that returns
  Local<Object> obj;
  if (!empty.ToLocal(&obj)) {
    // do some error handling
  }
  return obj; // just return the value or empty.
}

TEST_F(MaybeLocalTest, ReturnEmpty) {
  Isolate::Scope isolate_scope(isolate_);
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  MaybeLocal<Value> maybe = something();
  EXPECT_TRUE(maybe.IsEmpty());
}
```

# 小结

本节介绍了Chrome V8的一些基础知识，包括它的内存机制是怎样的，以及它的几个基础数据类型。

内存管理机制浅述了以空间换时间的高效新生代内存回收算法Scavenge，以及效率与碎片内存管理并存的Mark-Sweep和Mark-Compact结合体机制下的老生代内存回收算法。同时也介绍了新生代与老生代内存的一个联系，在特定情况下，新生代内存里面的对象会晋升到老生代对象中。

句柄是用于获取JavaScript对象实体的一种事物，有有效句柄连接的对象实体不会被垃圾回收器进行回收，而失去了所有句柄引用的对象实体会被认为是垃圾，从而在下次垃圾回收的时候被释放。