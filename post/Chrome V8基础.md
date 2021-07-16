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

其大致相当于一个沙箱化的执行上下文环境，内部预置了一系列的对象和函数，具体细节将在后文继续探讨。

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

# 句柄作用域（HandleScope）

在代码中，句柄作用域以HandleScope或者EscapableHandleScope的形式存在于栈内存中，其实际上是一个维护一堆句柄的容器。当一个句柄作用域对象的析构函数被调用时，在这个作用域中创建的所有句柄都会被从栈中抹去。于是，通常情况下这些句柄所指的对象将会失去所有引用，然后被GC统一处理。

作用域是一个套一个的以栈的形式存在的，在栈顶的句柄作用域处于激活状态。每次创建新的被管理对象的时候，都会将对象交付给栈顶的作用域管理，当栈顶作用域生命周期结束时，这段时间创建的对象就会被回收。

## 一般句柄作用域（Handle Scope）

一个HandleScope只有三个成员：

```c++
  internal::Isolate* isolate_;
  internal::Address* prev_next_;
  internal::Address* prev_limit_;
```

让我们看看创建一个作用域时会发生哪些事

```c++
  v8::HandleScope handle_scope{isolate_};
```

构造函数只是单纯的跳到Initialize函数

```c++
HandleScope::HandleScope(Isolate* isolate) { Initialize(isolate); }
```

```c++
void HandleScope::Initialize(Isolate* isolate) {
  i::Isolate* internal_isolate = reinterpret_cast<i::Isolate*>(isolate);
   // ApiCheck(),skip
  i::HandleScopeData* current = internal_isolate->handle_scope_data();
  isolate_ = internal_isolate;
  prev_next_ = current->next;
  prev_limit_ = current->limit;
  current->level++;
}
```

```c++
HandleScopeData* handle_scope_data() { return &handle_scope_data_; }
HandleScopeData handle_scope_data_;
```

HandleScopeData是一个定义在`src/handles/handles.h`中的结构体

```c++
struct HandleScopeData final {
  Address* next;
  Address* limit;
  int level;
  int sealed_level;
  CanonicalHandleScope* canonical_scope;

  void Initialize() {
    next = limit = nullptr;
    sealed_level = level = 0;
    canonical_scope = nullptr;
  }
};
```

析构函数

```c++
HandleScope::~HandleScope() {
  i::HandleScope::CloseScope(isolate_, prev_next_, prev_limit_);
}
```

```c++
void HandleScope::CloseScope(Isolate* isolate, Address* prev_next,
                             Address* prev_limit) {
#ifdef DEBUG
  int before = FLAG_check_handle_count ? NumberOfHandles(isolate) : 0;
#endif
  DCHECK_NOT_NULL(isolate);
  HandleScopeData* current = isolate->handle_scope_data();

  std::swap(current->next, prev_next);
  current->level--;
  Address* limit = prev_next;
  if (current->limit != prev_limit) {
    current->limit = prev_limit;
    limit = prev_limit;
    DeleteExtensions(isolate);
  }
#ifdef ENABLE_HANDLE_ZAPPING
  ZapRange(current->next, limit);
#endif
  MSAN_ALLOCATED_UNINITIALIZED_MEMORY(
      current->next,
      static_cast<size_t>(reinterpret_cast<Address>(limit) -
                          reinterpret_cast<Address>(current->next)));
#ifdef DEBUG
  int after = FLAG_check_handle_count ? NumberOfHandles(isolate) : 0;
  DCHECK_LT(after - before, kCheckHandleThreshold);
  DCHECK_LT(before, kCheckHandleThreshold);
#endif
}
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8_test_fixture.h"
#include "v8.h"
#include "src/handles/handles-inl.h"
#include "src/objects/objects-inl.h"
#include "src/objects/contexts-inl.h"
#include "src/api/api-inl.h"

namespace i = v8::internal;

class HandleScopeTest : public V8TestFixture { };

TEST_F(HandleScopeTest, HandleScopeData) {
  i::Isolate* isolate = asInternal(isolate_);
  i::HandleScope handle_scope(isolate);
  i::HandleScopeData data{};
  data.Initialize();
  EXPECT_EQ(data.next, nullptr);
  EXPECT_EQ(data.limit, nullptr);
  EXPECT_EQ(data.canonical_scope, nullptr);
  EXPECT_EQ(data.level, 0);
  EXPECT_EQ(data.sealed_level, 0);
}

TEST_F(HandleScopeTest, Create) {
  i::Isolate* i_isolate = asInternal(isolate_);
  i_isolate->handle_scope_data()->Initialize();
  i::HandleScope handle_scope{i_isolate};
  i::Object obj{18};
  i::Handle<i::Object> handle(obj, i_isolate);
  EXPECT_FALSE(handle.is_null());
  EXPECT_EQ(*handle, obj);

  i::HandleScopeData* data = i_isolate->handle_scope_data();
  EXPECT_EQ(data->level, 1);
}

TEST_F(HandleScopeTest, HandleScopeImplementer) {
  i::Isolate* i_isolate = asInternal(isolate_);
  i::HandleScopeImplementer implementer{i_isolate};
  // Context is just a HeapObject so we can construct using the default not
  // args constructor.
  i::Context context{};

  implementer.SaveContext(context);
  EXPECT_TRUE(implementer.HasSavedContexts());

  implementer.EnterContext(context);
  EXPECT_EQ(static_cast<int>(implementer.EnteredContextCount()), 1);
  implementer.LeaveContext();
  EXPECT_EQ(static_cast<int>(implementer.EnteredContextCount()), 0);

  i::DetachableVector<i::Address*>* blocks = implementer.blocks();
  EXPECT_TRUE(blocks->empty());
  i::Address* block = implementer.GetSpareOrNewBlock();
  blocks->push_back(block);
  EXPECT_FALSE(blocks->empty());
}
```

让我们用Chrome V8的样例代码([samples/hello-world.cc](https://chromium.googlesource.com/v8/v8/+/branch-heads/6.8/samples/hello-world.cc))来分析下它的作用：

```c++
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "include/libplatform/libplatform.h"
#include "include/v8.h"
int main(int argc, char* argv[]) {
  // Initialize V8.
  v8::V8::InitializeICUDefaultLocation(argv[0]);
  v8::V8::InitializeExternalStartupData(argv[0]);
  std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  // Create a new Isolate and make it the current one.
  v8::Isolate::CreateParams create_params;
  create_params.array_buffer_allocator =
      v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate* isolate = v8::Isolate::New(create_params);
  {
    v8::Isolate::Scope isolate_scope(isolate);
    // Create a stack-allocated handle scope.
    v8::HandleScope handle_scope(isolate);
    // Create a new context.
    v8::Local<v8::Context> context = v8::Context::New(isolate);
    // Enter the context for compiling and running the hello world script.
    v8::Context::Scope context_scope(context);
    // Create a string containing the JavaScript source code.
    v8::Local<v8::String> source =
        v8::String::NewFromUtf8(isolate, "'Hello' + ', World!'",
                                v8::NewStringType::kNormal)
            .ToLocalChecked();
    // Compile the source code.
    v8::Local<v8::Script> script =
        v8::Script::Compile(context, source).ToLocalChecked();
    // Run the script to get the result.
    v8::Local<v8::Value> result = script->Run(context).ToLocalChecked();
    // Convert the result to an UTF8 string and print it.
    v8::String::Utf8Value utf8(isolate, result);
    printf("%s\n", *utf8);
  }
  // Dispose the isolate and tear down V8.
  isolate->Dispose();
  v8::V8::Dispose();
  v8::V8::ShutdownPlatform();
  delete create_params.array_buffer_allocator;
  return 0;
}
```

在下图中，我们可以看到句柄堆栈和堆分配的对象。不妨在`v8::Local<v8::Context> context = v8::Context::New(isolate);`下面加上一句代码`Persistent<Context> persistent_context(isolate, context);`，便于理解持久句柄。

> 图片来自[Getting started with embedding V8 · V8](https://v8.dev/docs/embed)

![句柄与句柄作用域](https://v8.dev/_img/docs/embed/local-persist-handles-review.png)

1. `HandleScope handle_scope(isolate);`  创建一个句柄作用域，根据C++的特性，在它所处的作用域结束时，其生命周期也就结束了，这时候程序会自动调用它的析构函数。
2. `Local<Context> context = Context::New(isolate);` 创建一个Context对象，并得到它的本地句柄。该句柄存在于`handle_scope`的句柄栈中，被这个HandleScope对象管理，同时它的真实对象存在于堆内存中，被GC盯着。
3. `Persistent<Context> persistent_context(isolate, context);` 基于context我们创建一个新的持久句柄和`Context`对象，它不再受句柄作用域掌控，直接被GC管理。
4. `Context::Scope context_scope(context);` 进入context以编译和执行hello world脚本。
5. `Local<String> source = String::NewFromUtf8(...).ToLocalChecked();` 将一段JavaScript代码赋值给一个V8字符串，并得到句柄。
6.  `Local<Script> script = Script::Compile(context, source).ToLocalChecked();` 编译代码。
7. `Local<Value> result = script->Run(context).ToLocalChecked();` 执行代码。

最后，当HandleScope的析构函数被调用时，这些在这个句柄作用域中被创建的句柄和对象如果没有其他地方有引用的话，就会在下一次垃圾回收的时候被处理掉。不过我们创建的那个持久句柄并不会在析构时被处理，我们只能显式的调用Reset清除它。

## 可逃句柄作用域（Escapable Handle Scope）

根据上文所说，如果一个函数有一个 HandleScope 并且想要返回一个本地句柄，该句柄在函数返回后会变得不可用。这就是`EscapableHandleScope`的作用了，它有一个`Escape`函数，可以给一个句柄以豁免权，将其复制到一个封闭的作用域中并删除其他的本地句柄，然后返回这个新复制的可以安全返回的句柄。

```c++
class V8_EXPORT V8_NODISCARD EscapableHandleScope : public HandleScope {
 public:
  explicit EscapableHandleScope(Isolate* isolate);
  V8_INLINE ~EscapableHandleScope() = default;

  /**
   * Pushes the value into the previous scope and returns a handle to it.
   * Cannot be called twice.
   */
  template <class T>
  V8_INLINE Local<T> Escape(Local<T> value) {
    internal::Address* slot =
        Escape(reinterpret_cast<internal::Address*>(*value));
    return Local<T>(reinterpret_cast<T*>(slot));
  }

  template <class T>
  V8_INLINE MaybeLocal<T> EscapeMaybe(MaybeLocal<T> value) {
    return Escape(value.FromMaybe(Local<T>()));
  }

  EscapableHandleScope(const EscapableHandleScope&) = delete;
  void operator=(const EscapableHandleScope&) = delete;

 private:
  // Declaring operator new and delete as deleted is not spec compliant.
  // Therefore declare them private instead to disable dynamic alloc
  void* operator new(size_t size);
  void* operator new[](size_t size);
  void operator delete(void*, size_t);
  void operator delete[](void*, size_t);

  internal::Address* Escape(internal::Address* escape_value);
  internal::Address* escape_slot_;
};
```

构造函数：

```c++
EscapableHandleScope::EscapableHandleScope(Isolate* v8_isolate) {
  i::Isolate* isolate = reinterpret_cast<i::Isolate*>(v8_isolate);
  escape_slot_ = CreateHandle(isolate, i::ReadOnlyRoots(isolate).the_hole_value().ptr());
  Initialize(v8_isolate);
}
```

当一个`EscapableHandleScope`被创建的时候它会创建一个带有`the_hole_value`的Handle并将其存在Address中。后续作用域可以设置需要逃逸的指针地址，当到期时正常设置一个新的HandleScope。

```c++
i::Address* HandleScope::CreateHandle(i::Isolate* isolate, i::Address value) {
  return i::HandleScope::CreateHandle(isolate, value);
}
```

定义在`handles-inl.h`中

```c++
Address* HandleScope::CreateHandle(Isolate* isolate, Address value) {
  DCHECK(AllowHandleAllocation::IsAllowed());
  HandleScopeData* data = isolate->handle_scope_data();
  Address* result = data->next;
  if (result == data->limit) {
    result = Extend(isolate);
  }
  // Update the current next field, set the value in the created handle,
  // and return the result.
  DCHECK_LT(reinterpret_cast<Address>(result),
            reinterpret_cast<Address>(data->limit));
  data->next = reinterpret_cast<Address*>(reinterpret_cast<Address>(result) +
                                          sizeof(Address));
  *result = value;
  return result;
}
```

Escape函数：

```c++
i::Address* EscapableHandleScope::Escape(i::Address* escape_value) {
  i::Heap* heap = reinterpret_cast<i::Isolate*>(GetIsolate())->heap();
  Utils::ApiCheck(i::Object(*escape_slot_).IsTheHole(heap->isolate()),
                  "EscapableHandleScope::Escape", "Escape value set twice");
  if (escape_value == nullptr) {
    *escape_slot_ = i::ReadOnlyRoots(heap).undefined_value().ptr();
    return nullptr;
  }
  *escape_slot_ = *escape_value;
  return escape_slot_;
}
```

样例代码：

```c++
// This function returns a new array with three elements, x, y, and z.
Local<Array> NewPointArray(int x, int y, int z) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();

  // We will be creating temporary handles so we use a handle scope.
  v8::EscapableHandleScope handle_scope(isolate);

  // Create a new empty array.
  v8::Local<v8::Array> array = v8::Array::New(isolate, 3);

  // Return an empty result if there was an error creating the array.
  if (array.IsEmpty())
    return v8::Local<v8::Array>();

  // Fill out the values
  array->Set(0, Integer::New(isolate, x));
  array->Set(1, Integer::New(isolate, y));
  array->Set(2, Integer::New(isolate, z));

  // Return the value through Escape.
  return handle_scope.Escape(array);
}
```

# 上下文（Context）

上下文是Chrome V8中的JavaScript代码执行环境，所以当你想执行JavaScript代码的时候，必须为其指定一个Context：

```c++
Local<Script> script = Script::Compile(context, source).ToLocalChecked();
```

在Chrome V8中，除了Isolate实例是各自独立的，上下文也是独立且允许存在多个的。在同一个Isolate中，不同的上下文也是不相干的，其可以执行各自的JavaScript代码。

上下文对象在堆上分配，因此应该是Data对象。这允许通过 API 在 GC 中进行跟踪来处理它们。具体可以参见`v8.h`中的定义`class V8_EXPORT Context : public Data {...}`

从CPU运行时间和内存的角度来看，创建一个新的执行上下文的开销很大，但是V8的缓存机制让这个操作在第二次、第三次以及更多次数的时候让开销变小很多。原因在于这个开销的大头是解析“创建内置对象的JavaScript代码”。在第一次创建成功之后，下次创建就不需要再解析这些代码，而是直接执行这些代码来创建内置对象。与此同时，如果在编译V8的时候加入编译选项`snapshop=yes`的话，这些创建好的内置对象会被放入快照中，可在创建上下文的时候直接到快照中取。这就是Chrome V8高效的另一方面的体现了——善用缓存。具体细节会在之后的文章中探讨（`src/snapshot/snapshot.cc`)。

```c++
Local<Context> context = Context::FromSnapshot(isolate, index).ToLocalChecked();
```

创建一个Context后我们可以多次进入或退出它，当我们在Context A时也可以切换成不同的Context B，当退出B时返回A，如下图：

![intro-contexts](https://v8.dev/_img/docs/embed/intro-contexts.png)

需要注意的是每个上下文的内置函数和对象都是分离的，当我们创建上下文时可以设置security token，具体请参阅[Security Model](https://v8.dev/docs/embed#security-model)。

# 模板（Template）

这里的模板可不是值C++中的模板，Chrome V8中的模板指的是在上下文中JavaScript对象以及函数的一个模具。你可以用一个模板来把C++函数或者数据结构包裹进JavaScript的对象中，这样JavaScript就能对它做一些不可描述的事情了。实际上Google Chrome中的DOM节点就是用C++完成，然后再用模板包裹成JavaScript对象，这样我们就能在浏览器中使用JavaScript来对它们进行操作了。

模板是一个对象模板和函数模板的超类，需要注意的是在JavaScript中函数也能和对象一样拥有属性字段。

```c++
class V8_EXPORT Template : public Data {
 public:

  void Set(Local<Name> name, Local<Data> value,
           PropertyAttribute attributes = None);
  void SetPrivate(Local<Private> name, Local<Data> value,
                  PropertyAttribute attributes = None);
  V8_INLINE void Set(Isolate* isolate, const char* name, Local<Data> value);

  void SetAccessorProperty(
     Local<Name> name,
     Local<FunctionTemplate> getter = Local<FunctionTemplate>(),
     Local<FunctionTemplate> setter = Local<FunctionTemplate>(),
     PropertyAttribute attribute = None,
     AccessControl settings = DEFAULT);

  void SetNativeDataProperty(
      Local<String> name, AccessorGetterCallback getter,
      AccessorSetterCallback setter = nullptr,
      Local<Value> data = Local<Value>(), PropertyAttribute attribute = None,
      Local<AccessorSignature> signature = Local<AccessorSignature>(),
      AccessControl settings = DEFAULT,
      SideEffectType getter_side_effect_type = SideEffectType::kHasSideEffect,
      SideEffectType setter_side_effect_type = SideEffectType::kHasSideEffect);
  void SetNativeDataProperty(
      Local<Name> name, AccessorNameGetterCallback getter,
      AccessorNameSetterCallback setter = nullptr,
      Local<Value> data = Local<Value>(), PropertyAttribute attribute = None,
      Local<AccessorSignature> signature = Local<AccessorSignature>(),
      AccessControl settings = DEFAULT,
      SideEffectType getter_side_effect_type = SideEffectType::kHasSideEffect,
      SideEffectType setter_side_effect_type = SideEffectType::kHasSideEffect);

  void SetLazyDataProperty(
      Local<Name> name, AccessorNameGetterCallback getter,
      Local<Value> data = Local<Value>(), PropertyAttribute attribute = None,
      SideEffectType getter_side_effect_type = SideEffectType::kHasSideEffect,
      SideEffectType setter_side_effect_type = SideEffectType::kHasSideEffect);

  void SetIntrinsicDataProperty(Local<Name> name, Intrinsic intrinsic,
                                PropertyAttribute attribute = None);

 private:
  Template();

  friend class ObjectTemplate;
  friend class FunctionTemplate;
};
```

`Set`函数可用于在从此模板创建的实例上设置名字和值，`SetAccessorProperty`函数用于获取或设置属性。

```c++
enum PropertyAttribute {
  /** None. **/
  None = 0,
  /** ReadOnly, i.e., not writable. **/
  ReadOnly = 1 << 0,
  /** DontEnum, i.e., not enumerable. **/
  DontEnum = 1 << 1,
  /** DontDelete, i.e., not configurable. **/
  DontDelete = 1 << 2
};

enum AccessControl {
  DEFAULT               = 0,
  ALL_CAN_READ          = 1,
  ALL_CAN_WRITE         = 1 << 1,
  PROHIBITS_OVERWRITING = 1 << 2
};
```

本文主要介绍两种模板，这两种模板均继承自Template：

+ 函数模板（Function Template）
+ 对象模板（Object Template）

## 函数模板（Function Template）

函数模板在Chrome V8中的数据类型是FunctionTemplate。它是一个JavaScript函数的模具。当生成一个函数模板后，我们通过调用它的`GetFunction`方法来获取其函数具体句柄，这个函数可以被JavaScript调用。

```c++
class V8_EXPORT FunctionTemplate : public Template { ... }
```

可以用下述方法定义

```c++
Local<FunctionTemplate> ft = FunctionTemplate::New(isolate_, function_callback, data);
Local<Function> function = ft->GetFunction(context).ToLocalChecked();
```

同时这样调用函数

```c++
MaybeLocal<Value> ret = function->Call(context, recv, 0, nullptr);
```

`Function::Call` 能在 `src/api/api.cc`中找到

```c++
MaybeLocal<v8::Value> Function::Call(Local<Context> context,
                                     v8::Local<v8::Value> recv, int argc,
                                     v8::Local<v8::Value> argv[]) {
  auto isolate = reinterpret_cast<i::Isolate*>(context->GetIsolate());
  TRACE_EVENT_CALL_STATS_SCOPED(isolate, "v8", "V8.Execute");
  ENTER_V8(isolate, context, Function, Call, MaybeLocal<Value>(),
           InternalEscapableScope);
  i::TimerEventScope<i::TimerEventExecute> timer_scope(isolate);
  auto self = Utils::OpenHandle(this);
  Utils::ApiCheck(!self.is_null(), "v8::Function::Call",
                  "Function to be called is a null pointer");
  i::Handle<i::Object> recv_obj = Utils::OpenHandle(*recv);
  STATIC_ASSERT(sizeof(v8::Local<v8::Value>) == sizeof(i::Handle<i::Object>));
  i::Handle<i::Object>* args = reinterpret_cast<i::Handle<i::Object>*>(argv);
  Local<Value> result;
  has_pending_exception = !ToLocal<Value>(
      i::Execution::Call(isolate, self, recv_obj, argc, args), &result);
  RETURN_ON_FAILED_EXECUTION(Value);
  RETURN_ESCAPED(result);
}
```

我们可以看到`Call`的返回值是一个`MaybeHandle<Object>`，会被传给定义在`api.h`内的`ToLocal`

```c++
template <class T>
inline bool ToLocal(v8::internal::MaybeHandle<v8::internal::Object> maybe,
                    Local<T>* local) {
  v8::internal::Handle<v8::internal::Object> handle;
  if (maybe.ToHandle(&handle)) {
    *local = Utils::Convert<v8::internal::Object, T>(handle);
    return true;
  }
  return false;
}
```

`Execution:Call`定义在`execution/execution.cc`中

```c++]
MaybeHandle<Object> Execution::Call(Isolate* isolate, Handle<Object> callable,
                                    Handle<Object> receiver, int argc,
                                    Handle<Object> argv[]) {
  return Invoke(isolate, InvokeParams::SetUpForCall(isolate, callable, receiver,
                                                    argc, argv));
}
```

`SetUpForCall` 返回一个 `InvokeParams`.

```c++
V8_WARN_UNUSED_RESULT MaybeHandle<Object> Invoke(Isolate* isolate,
                                                 const InvokeParams& params) 
```

```c++
Handle<Object> receiver = params.is_construct                             
                                    ? isolate->factory()->the_hole_value()         
                                    : params.receiver; 
```

当抛出异常时`Invoke`会返回一个空对象

```c++
auto value = Builtins::InvokeApiFunction(
    isolate, params.is_construct, function, receiver, params.argc,
    params.argv, Handle<HeapObject>::cast(params.new_target));
bool has_exception = value.is_null();
DCHECK(has_exception == isolate->has_pending_exception());
if (has_exception) {
  if (params.message_handling == Execution::MessageHandling::kReport) {
    isolate->ReportPendingMessages();
  }
  return MaybeHandle<Object>();
} else {
  isolate->clear_pending_message();
}
return value;
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "libplatform/libplatform.h"
#include "v8_test_fixture.h"
#include "src/objects/objects.h"
#include "src/objects/objects-inl.h"
#include "src/api/api-inl.h"

using namespace v8;

class FunctionTemplateTest : public V8TestFixture {
};

void function_callback(const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  std::cout << "function_callback args= " << info.Length() << '\n';

  // If the function was called using the new operator the property
  // new.target(NewTarget) will be set.
  Local<Value> new_target_value = info.NewTarget();
  if (new_target_value.IsEmpty()) {
    std::cout << "new_target_value is undefined: " << new_target_value->IsUndefined() << '\n';
  }
  // This is the receiver passed as the second argument to the Call function,
  // which is like the this.
  Local<Object> receiver = info.This();
  Local<Name> name = String::NewFromUtf8(isolate, "nr", NewStringType::kNormal).ToLocalChecked();
  Local<Value> nr_local = receiver->GetRealNamedProperty(isolate->GetCurrentContext(), name).ToLocalChecked();
  Local<Number> nr = nr_local->ToNumber(isolate->GetCurrentContext()).ToLocalChecked();

  Local<Object> holder = info.Holder();

  ReturnValue<Value> return_value = info.GetReturnValue();
  double nr2 = nr->Value() + 2;
  return_value.Set(nr2);

  EXPECT_STREQ(*String::Utf8Value(isolate, info.Data()), "some info");
}

TEST_F(FunctionTemplateTest, FunctionTemplate) {
  i::Isolate* i_isolate = V8TestFixture::asInternal(isolate_);
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  // This value, data, will be made available via the FunctionCallbackInfo:
  Local<Value> data = String::NewFromUtf8(isolate_, "some info", NewStringType::kNormal).ToLocalChecked();
  Local<FunctionTemplate> ft = FunctionTemplate::New(isolate_, function_callback, data);
  Local<Function> function = ft->GetFunction(context).ToLocalChecked();
  Local<String> func_name = String::NewFromUtf8(isolate_, "SomeFunc", NewStringType::kNormal).ToLocalChecked();
  function->SetName(func_name);
  Local<Value> prototype = function->GetPrototype();
  V8TestFixture::print_local(prototype);

  Local<Object> recv = Object::New(isolate_);
  Local<Name> name = String::NewFromUtf8(isolate_, "nr", NewStringType::kNormal).ToLocalChecked();
  Local<Number> value = Number::New(isolate_, 18);
  recv->Set(context, name, value).Check();

  int argc = 0;
  Local<Value> argv[] = {}; 
  MaybeLocal<Value> ret = function->Call(context, recv, argc, nullptr);
  if (!ret.IsEmpty()) {
    Local<Number> nr = ret.ToLocalChecked()->ToNumber(context).ToLocalChecked();
    EXPECT_EQ(nr->Value(), 20);
  }

  i::RootsTable roots_table = i_isolate->roots_table();
  i::Heap* heap = i_isolate->heap();

  //Local<Function> function2 = ft->GetFunction(context).ToLocalChecked();
  //MaybeLocal<Value> ret = function->Call(context, recv, 0, nullptr);
}

TEST_F(FunctionTemplateTest, FunctionTemplateInfo) {
  const HandleScope handle_scope(isolate_);
  Handle<Context> context = Context::New(isolate_);
  Context::Scope context_scope(context);

  // This value, data, will be made available via the FunctionCallbackInfo:
  Local<Value> data = String::NewFromUtf8(isolate_, "some info", NewStringType::kNormal).ToLocalChecked();
  Local<FunctionTemplate> ft = FunctionTemplate::New(isolate_, function_callback, data);
  i::Handle<i::FunctionTemplateInfo> ft_info = i::Handle<i::FunctionTemplateInfo>(
      reinterpret_cast<i::Address*>(const_cast<FunctionTemplate*>(*ft)));
  i::Isolate* i_isolate = V8TestFixture::asInternal(isolate_);
  i::Handle<i::SharedFunctionInfo> sfi = i::FunctionTemplateInfo::GetOrCreateSharedFunctionInfo(
      i_isolate, ft_info, i::MaybeHandle<i::Name>());
  //std::cout << sfi->Name() << '\n';
  //ft_info->GetCFunction(i_isolate);
}
```

## 对象模板（Object Template）

每个函数模板都有一个相关联的对象模板，这用于配置使用此函数创建的对象作为其构造函数。对象模板用于在运行时创建对象，从对象模板被创建的对象会被挂上被加到这个模板中的属性，大概类似于`const obj = {};`

定义在`include/v8.h`中

```c++
class V8_EXPORT ObjectTemplate : public Template {
  ...
}
class V8_EXPORT Template : public Data {
  ...
}
class V8_EXPORT Data {
 private:
  Data();  
};
```

我们创建一个对象模板的实例之后就可以给它添加属性，这样每个用该实例创建的对象实例都会带有该属性。此操作通过`Template`类中的成员函数`Set`实现，在`src/api/api.cc`中定义：

```c++
void Template::Set(v8::Local<Name> name, v8::Local<Data> value,
                   v8::PropertyAttribute attribute) {
  auto templ = Utils::OpenHandle(this);
  i::Isolate* isolate = templ->GetIsolate();
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(isolate);
  i::HandleScope scope(isolate);
  auto value_obj = Utils::OpenHandle(*value);

  Utils::ApiCheck(!value_obj->IsJSReceiver() || value_obj->IsTemplateInfo(),
                  "v8::Template::Set",
                  "Invalid value, must be a primitive or a Template");

  // The template cache only performs shallow clones, if we set an
  // ObjectTemplate as a property value then we can not cache the receiver
  // template.
  if (value_obj->IsObjectTemplateInfo()) {
    templ->set_serial_number(i::TemplateInfo::kDoNotCache);
  }

  i::ApiNatives::AddDataProperty(isolate, templ, Utils::OpenHandle(*name),
                                 value_obj,
                                 static_cast<i::PropertyAttributes>(attribute));
}
```

`Name`是`Symbol`和`String`的超类，它们都可以用作属性的名称。

```c++
Local<Value> Private::Name() const {
  const Symbol* sym = reinterpret_cast<const Symbol*>(this);
  i::Handle<i::Symbol> i_sym = Utils::OpenHandle(sym);
  // v8::Private symbols are created by API and are therefore writable, so we
  // can always recover an Isolate.
  i::Isolate* isolate = i::GetIsolateFromWritableObject(*i_sym);
  return sym->Description(reinterpret_cast<Isolate*>(isolate));
}
```

样例代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "libplatform/libplatform.h"
#include "v8_test_fixture.h"
#include "src/objects/objects.h"
#include "src/objects/objects-inl.h"
#include "src/api/api.h"

using namespace v8;

class ObjectTemplateTest : public V8TestFixture {
};

TEST_F(ObjectTemplateTest, AddProperty) {
  const HandleScope handle_scope(isolate_);
  Local<FunctionTemplate> constructor = Local<FunctionTemplate>();
  Local<ObjectTemplate> ot = ObjectTemplate::New(isolate_, constructor);

  // Add a property that all instanced created from this object template will
  // have. (Set is member function of class Template):
  const char* prop_name = "prop_name";
  const char* prop_value = "prop_value";
  Local<Name> name = String::NewFromUtf8(isolate_, prop_name, NewStringType::kNormal).ToLocalChecked();
  Local<Data> value = String::NewFromUtf8(isolate_, prop_value, NewStringType::kNormal).ToLocalChecked();
  ot->Set(name, value, PropertyAttribute::None);

  Handle<Context> context = Context::New(isolate_, nullptr, ot);
  MaybeLocal<Object> maybe_instance = ot->NewInstance(context);
  Local<Object> obj = maybe_instance.ToLocalChecked();

  // Verify that the property we added exist in the instance we created:
  MaybeLocal<Array> maybe_names = obj->GetPropertyNames(context);
  Local<Array> names = maybe_names.ToLocalChecked();
  EXPECT_EQ(static_cast<int>(names->Length()), 1);
  // If found it iteresting that Array does not have any methods except Length()
  // and thress static methods (New, New, and Cast). Since Array extends Object
  // we can use Object::Get with the index:
  Local<Value> name_from_array = names->Get(context, 0).ToLocalChecked();
  String::Utf8Value utf8_name{isolate_, name_from_array};
  EXPECT_STREQ(*utf8_name, prop_name);

  // Verify the value is correct.
  Local<Value> val = obj->GetRealNamedProperty(context, name).ToLocalChecked();
  EXPECT_TRUE(val->IsName());
  String::Utf8Value utf8_value{isolate_, val};
  EXPECT_STREQ(*utf8_value, prop_value);
}
```

### 访问器（Accessor）与拦截器（Interceptor）

访问器与拦截器是对象模板中两种不同的C++回调函数：

+ 访问器的回调函数会在模板对象生成的对象中指定属性被访问时执行
+ 拦截器的回调函数会在模板对象生成的对象中任何属性被访问时执行

可以使用ObjectTemplate的SetAccessor函数为对象模板或者对象创建一个访问器：

```c++
void ObjectTemplate::SetAccessor(v8::Local<String> name,
                                 AccessorGetterCallback getter,
                                 AccessorSetterCallback setter,
                                 v8::Local<Value> data, AccessControl settings,
                                 PropertyAttribute attribute,
                                 v8::Local<AccessorSignature> signature,
                                 SideEffectType getter_side_effect_type,
                                 SideEffectType setter_side_effect_type) {
  TemplateSetAccessor(this, name, getter, setter, data, settings, attribute,
                      signature, i::FLAG_disable_old_api_accessors, false,
                      getter_side_effect_type, setter_side_effect_type);
}
```

其中name是访问器的属性名，getter是访问器的get函数，setter是访问器的set函数，其类型也可以为`v8::Local<Name> name, AccessorNameGetterCallback getter, AccessorNameSetterCallback setter`。

拦截器与访问器有相似之处，只不过访问器是针对某个特定的访问设置的getter和setter，而拦截器则是对于一个对象实例的所有相关访问进行拦截。一般一个对象模板有两种不同类型的拦截器可以设置：

+ **映射型拦截器（Named Property Interceptor）**： 当对于一个对象内成员的访问方式是字符串型的属性名时，映射型拦截器就会生效，比如在Chrome浏览器中，文档中的一些访问就是映射型拦截器`document.theFormName.elementName`
+ **索引型拦截器（Indexed Property Interceptor）**： 与映射型拦截器不同，索引型拦截器的访问与数组类似，通过整型下标来对内容进行访问。比如在Chrome浏览器中，`document.forms.elements[0]`这种形式的访问就是索引型拦截器的一种体现。

对象模板通过`SetHandler`来对这个模板设置拦截器，通过传入不同类型的配置对象来决定设置的是映射型拦截器还是索引型拦截器。定义在`api.cc`中

```c++
void ObjectTemplate::SetHandler(
    const NamedPropertyHandlerConfiguration& config) {
  ObjectTemplateSetNamedPropertyHandler(
      this, config.getter, config.setter, config.query, config.descriptor,
      config.deleter, config.enumerator, config.definer, config.data,
      config.flags);
}

void ObjectTemplate::SetHandler(
    const IndexedPropertyHandlerConfiguration& config) {
  i::Isolate* isolate = Utils::OpenHandle(this)->GetIsolate();
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(isolate);
  i::HandleScope scope(isolate);
  auto cons = EnsureConstructor(isolate, this);
  EnsureNotPublished(cons, "v8::ObjectTemplate::SetHandler");
  auto obj = CreateIndexedInterceptorInfo(
      isolate, config.getter, config.setter, config.query, config.descriptor,
      config.deleter, config.enumerator, config.definer, config.data,
      config.flags);
  i::FunctionTemplateInfo::SetIndexedPropertyHandler(isolate, cons, obj);
}
```

`NamedPropertyHandlerConfiguration`类定义在`v8.h`中，这个类的对象用于配置一个映射型拦截器。

```c++
struct NamedPropertyHandlerConfiguration {

  ...

  NamedPropertyHandlerConfiguration(
      /** Note: getter is required */
      GenericNamedPropertyGetterCallback getter = nullptr,
      GenericNamedPropertySetterCallback setter = nullptr,
      GenericNamedPropertyQueryCallback query = nullptr,
      GenericNamedPropertyDeleterCallback deleter = nullptr,
      GenericNamedPropertyEnumeratorCallback enumerator = nullptr,
      Local<Value> data = Local<Value>(),
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter),
        setter(setter),
        query(query),
        deleter(deleter),
        enumerator(enumerator),
        definer(nullptr),
        descriptor(nullptr),
        data(data),
        flags(flags) {}

...
    
};
```

我们重点关注它的构造函数， `getter`是拦截器的`getter`函数，其在函数内部为`info`返回`getter`的值。

```c++
using GenericNamedPropertyGetterCallback =
    void (*)(Local<Name> property, const PropertyCallbackInfo<Value>& info);
```

`setter` 是拦截器的`setter`函数，其在函数内部把`value`的值设置到相应的地方。

```c++
using GenericNamedPropertySetterCallback =
    void (*)(Local<Name> property, Local<Value> value,
             const PropertyCallbackInfo<Value>& info);
```

`query`用于对象内查询某属性状态，如只读、不可枚举等，其在函数内部为`info`返回一个`Local<Number>`的值，代表它的状态，如`v8::ReadOnly` 、`v8::DontDelete`、`v8::None`等。

```c++
using GenericNamedPropertyQueryCallback =
    void (*)(Local<Name> property, const PropertyCallbackInfo<Integer>& info);
```

`deleter`用于对象内删除属性，其在函数内部做相应的删除操作之后为`info`返回一个是否可删除的`Local<Boolean>`布尔值。

```c++
using GenericNamedPropertyDeleterCallback =
    void (*)(Local<Name> property, const PropertyCallbackInfo<Boolean>& info);
```

`enumerator`用于对象枚举，如定义了`for...in`、`console.log`等执行结果的行为等，其在函数内部为`info`返回一个字段数组，表示这个对象可枚举出来的字段名。

```c++
using GenericNamedPropertyEnumeratorCallback =
    void (*)(const PropertyCallbackInfo<Array>& info);
```

`data`这个参数将会被传入上述的各种函数中使用，在`PropertyCallbackInfo`的对象中，有一个`Data()`函数就是用来获取这个`data`用的，如`info.Data()`。

`flags`表示这个拦截器的一些标识,主要值如下：

```c++
/**
 * Configuration flags for v8::NamedPropertyHandlerConfiguration or
 * v8::IndexedPropertyHandlerConfiguration.
 */
enum class PropertyHandlerFlags {
  /**
   * None. 无标识
   */
  kNone = 0,

  /**
   * See ALL_CAN_READ above.  所有属性可读
   */
  kAllCanRead = 1,

  /** Will not call into interceptor for properties on the receiver or prototype
   * chain, i.e., only call into interceptor for properties that do not exist.
   * Currently only valid for named interceptors.
   */
  kNonMasking = 1 << 1,

  /**
   * Will not call into interceptor for symbol lookup.  Only meaningful for
   * named interceptors.
   */
  kOnlyInterceptStrings = 1 << 2,

  /**
   * The getter, query, enumerator callbacks do not produce side effects.
   */
  kHasNoSideEffect = 1 << 3,
};
```



索引型拦截器（Indexed Property Interpector）拦截的是数字下标访问的属性，我们可以用JavaScript中普通对象和数组的不同来类比映射型拦截器和索引型拦截器的不同。就使用方法来说，索引型拦截器和映射型拦截器大同小异。它们均通过`SetHandler`函数来设置拦截器，只不过索引型拦截器传的参数是一个`IndexedPropertyHandlerConfiguration`的对象，该类的构造函数如下：

```c++
struct IndexedPropertyHandlerConfiguration {
 
    ...
     
  IndexedPropertyHandlerConfiguration(
      /** Note: getter is required */
      IndexedPropertyGetterCallback getter = nullptr,
      IndexedPropertySetterCallback setter = nullptr,
      IndexedPropertyQueryCallback query = nullptr,
      IndexedPropertyDeleterCallback deleter = nullptr,
      IndexedPropertyEnumeratorCallback enumerator = nullptr,
      Local<Value> data = Local<Value>(),
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter),
        setter(setter),
        query(query),
        deleter(deleter),
        enumerator(enumerator),
        definer(nullptr),
        descriptor(nullptr),
        data(data),
        flags(flags) {}

	...
    
};
```

看起来和映射型拦截器的配置对象也基本一致，只不过里面的各种回调函数的类型前缀不一样。当然，写这些函数的时候也是不一样的。

在映射型拦截器的各种回调函数中，第一个参数是一个`Name`数据对象的本地句柄（`Local<Name>`），而索引型拦截器的各种回调函数中的第一个参数则是一个`uint32_t`型的C++底层数据类型，即无符号32位整型，如下：

```c++
using IndexedPropertyGetterCallback =
    void (*)(uint32_t index, const PropertyCallbackInfo<Value>& info);
```

## 对象模板的内置字段（Internal Field）

在V8中，能与JavaScript代码中直接交互的数据类型都是以句柄形式出现的V8数据类型，如`v8::Number`等，以及对象`v8::Object`。在`v8::Object`中，存在的也都是一些同类的数据。

当我们有一个自身的底层数据结构需要和V8的数据类型联系起来时，就涉及到了V8对象的另一个概念——内置字段。该字段对于JavaScript代码来说是不可见的，只有到C++的层面，才能通过`v8::Object`的特定方法将其获取出来，可以简单将其理解为V8对象数据类型的私有属性。

# 常用数据类型

对前面提到的一些数据类型加以说明

## 基值（Value）

`v8::Value`是Chrome V8在JavaScript层面用到的各种数据（如`Number`、`String`、`Function`等）的一个总的基类，也就是说这些数据类型都是从`Value`继承而来的。所以我们经常能从代码中看到`Value`类型的本地句柄，也就是`Local<Value>`。关于Chrome V8的Value继承关系可以参阅[文档](https://v8docs.nodesource.com/node-16.0/dc/d0a/classv8_1_1_value.html)。

由于`Value`是很多JavaScript数据类型的父类，因此当遇到这种数据的句柄时，我们可以认为它是某一种数据类型的抽象。至于想要知道具体是哪一种数据类型，或者想要将其转换成特定的一种数据类型，就要依靠`Value`的各种API了。举个栗子：

```c++
V8_WARN_UNUSED_RESULT MaybeLocal<Number> ToNumber(Local<Context> context) const;
V8_WARN_UNUSED_RESULT MaybeLocal<String> ToNumber(Local<String> context) const;
...
```

## 字符串（String）

V8中有许多不同的String类型，它们针对各种情况进行了优化，可以在`src/objects/objects.h`中看到层次结构：

```c++
    Object
      SMI
      HeapObject    // superclass for every object instans allocated on the heap.
        ...
        Name
          String
            SeqString
              SeqOneByteString
              SeqTwoByteString
            SlicedString
            ConsString
            ThinString
            ExternalString
              ExternalOneByteString
              ExternalTwoByteString
            InternalizedString
              SeqInternalizedString
                SeqOneByteInternalizedString
                SeqTwoByteInternalizedString
              ConsInternalizedString
              ExternalInternalizedString
                ExternalOneByteInternalizedString
                ExternalTwoByteInternalizedString
```

不过`v8::String`定义在`include/v8.h`中。可以看到String继承自Name

```c++
    int GetIdentityHash();
    static Name* Cast(Value* obj)
```

### Unicode

Unicode里的抽象字符（Abstract characters）有类似于`LATIN SMALL LETTER A`的名字，`Code point`是一个和抽象字符相关联的数字，比如`U+0061`，其中U表示Unicode。从U+n0000到U+nFFFF，65536个连续的code points叫做一个plane，如下：

```apl
Plane 0: U+0000 -> U+FFFF           Basic Multilingual Plane (BMP)
Plane 1: U+10000 -> U+1FFFF         Supplementary Multilingual Plane
Plane 2: U+20000 -> U+2FFFF         Supplementary Ideographic Plane
Plane 3: U+30000 -> U+3FFFF
...
Plane 16: U+100000 -> U+10FFFF      Supplementary Private Use Area B.
```

BPM包含编程时使用的绝大部分字符，用四个十六进制数字表示。

计算机中的内存不处理code points或者abstract characters，而是处理作为一个bit sequence的code uints。code points仅仅是一个查找抽象字符的数字而已，我们可以用一个函数将code point转换成code unit，这个过程就叫做字符编码。计算机中存在着很多种编码，JavaScript使用的是UTF-16（16-bit Unicode Transformation Format）。

### String

String就是一个拥有长度和内容的`Name`，内容由一个或两个字节组成，查看`include/v8.h`中 的定义：

```c++
    enum Encoding {
      UNKNOWN_ENCODING = 0x1,
      TWO_BYTE_ENCODING = 0x0,
      ONE_BYTE_ENCODING = 0x8
    };

    int Length() const;
    int Uft8Length const;
    bool IsOneByte() const;
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include "libplatform/libplatform.h"
#include "v8_test_fixture.h"

using namespace v8;

class StringTest : public V8TestFixture {
};

TEST_F(StringTest, create) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> str = String::NewFromOneByte(isolate_, 
      reinterpret_cast<const uint8_t*>("bajja"),
      NewStringType::kNormal,
      6).ToLocalChecked();
  String::Utf8Value value(isolate_, str);
  EXPECT_STREQ("bajja", *value);
  EXPECT_EQ(str->Length(), 6);
  EXPECT_EQ(str->Utf8Length(isolate_), 6);
  EXPECT_EQ(str->IsOneByte(), true);
  EXPECT_EQ(str->IsExternal(), false);
  EXPECT_EQ(str->IsExternalOneByte(), false);
}

TEST_F(StringTest, NewFromUtf8) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> str = String::NewFromUtf8(isolate_, "åäö").ToLocalChecked();
  EXPECT_EQ(str->Length(), 3);
  EXPECT_EQ(str->Utf8Length(isolate_), 6);
  EXPECT_EQ(str->IsOneByte(), true);
}

TEST_F(StringTest, fromStringLiteral) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> str = String::NewFromUtf8Literal(isolate_, "something");
  EXPECT_EQ(str->Length(), 9);
  EXPECT_EQ(str->Utf8Length(isolate_), 9);
  EXPECT_EQ(str->IsOneByte(), true);
}

TEST_F(StringTest, empty) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> str = String::Empty(isolate_); 
  EXPECT_EQ(str->Length(), 0);
  EXPECT_EQ(str->Utf8Length(isolate_), 0);
  EXPECT_EQ(str->IsOneByte(), true);
  EXPECT_EQ(str->ContainsOnlyOneByte(), true);
  v8::String::Utf8Value empty(isolate_, str);
  EXPECT_STREQ(*empty, "");
}

TEST_F(StringTest, concat) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> left = String::NewFromOneByte(isolate_, 
      reinterpret_cast<const uint8_t*>("hey"),
      NewStringType::kNormal,
      6).ToLocalChecked();
  Local<String> right = String::NewFromOneByte(isolate_, 
      reinterpret_cast<const uint8_t*>(" bajja"),
      NewStringType::kNormal,
      6).ToLocalChecked();
  Local<String> joined = String::Concat(isolate_, left, right);
  EXPECT_EQ(joined->Length(), 12);
}

TEST_F(StringTest, compare) {
  const v8::HandleScope handle_scope(isolate_);
  Isolate::Scope isolate_scope(isolate_);
  Local<String> first = String::NewFromOneByte(isolate_,
      reinterpret_cast<const uint8_t*>("hey"),
      NewStringType::kNormal,
      6).ToLocalChecked();
  Local<String> second = String::NewFromOneByte(isolate_,
      reinterpret_cast<const uint8_t*>("hey"),
      NewStringType::kNormal,
      6).ToLocalChecked();
  v8::String::Utf8Value first_utf8(isolate_, first);
  v8::String::Utf8Value second_utf8(isolate_, second);
  EXPECT_STREQ(*first_utf8, *second_utf8);
}
```

这是v8.h中唯一的字符串类，但它有很多实现以用于多种用途。

### NewFromUtf8

String数据类型有多个静态函数可以从一个`char*`指针建立起一个V8字符串数据，最常用的一个就是String的静态函数`NewFromUtf8`，其就是从一个UTF8数据中新建一个String数据。

一般用法如下为： `  Local<String> str = String::NewFromUtf8(isolate_, "åäö").ToLocalChecked();    `

现在`String::NewFromUtf8`长这样：

```c++
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate, const char* data,
                                       NewStringType type, int length) {
  NEW_STRING(isolate, String, NewFromUtf8, char, data, type, length);
  return result;  
}
```

`NEW_STRING`宏在`src/api/api.cc`中可以找到，可以用下述命令查看展开后的样子：

```shell
$ g++ -I./out/x64.release_gcc/gen -I./include -I. -E src/api/api.cc > output
```

```c++
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate, const char* data,
                                       NewStringType type, int length) {
  MaybeLocal<String> result;
  if (length == 0) {
    result = String::Empty(isolate);
  } else if (length > i::String::kMaxLength) {
    result = MaybeLocal<String>();
  } else {
    i::Isolate* i_isolate = reinterpret_cast<internal::Isolate*>(isolate);
    i::VMState<v8::OTHER> __state__((i_isolate));;
    i::RuntimeCallTimerScope _runtime_timer( i_isolate, i::RuntimeCallCounterId::kAPI_String_NewFromUtf8);
    do {
      auto&& logger = (i_isolate)->logger();
      if (logger->is_logging())
        logger->ApiEntryCall("v8::" "String" "::" "NewFromUtf8");
    } while (false);
    if (length < 0)
      length = StringLength(data);
     i::Handle<i::String> handle_result = NewString(i_isolate->factory(), type, i::Vector<const char>(data, length)) .ToHandleChecked();
     result = Utils::ToLocal(handle_result);
  };
  return result;  
}
```

有很多的检查是不需要的，可以移到编译时检查，比如字符串的最大长度：

```c++
  template <int N>
  static V8_WARN_UNUSED_RESULT Local<String> NewFromUtf8Literal(
      Isolate* isolate, const char (&literal)[N],
      NewStringType type = NewStringType::kNormal) {
    static_assert(N <= kMaxLength, "String is too long");
    return NewFromUtf8Literal(isolate, literal, type, N - 1);      
  }
```

`static_assert`在编译时检查。

## 数值类型

数值类型在V8中代表的意义很宽泛，有些中间数值类型从`Number`中继承出来，所以也属于V8的数值类型，如:

+ `Integer` 继承自`Number`
+ `Int32` 继承自`Integer`
+ `Uint32` 继承自`Integer`

关于数值类型的用法很简单，常用的无非是静态函数`New()`以及成员函数`Value()`。

```c++
double Number::Value() const; // Value()函数声明，返回一个double数值
static Local<Number> New(Isolate* isolate, double value); // New()函数声明
```

相应地，`Integer`以及其他几个数值类型也有其相应的`New()`函数和`Value()`函数。不过值得注意的是`Integer::Value()`的返回值是`int64_t`类型的数据，但是在`New()`的时候传的却需要是`int32_t`或者`uint32_t`。

## 布尔类型（Boolean)

布尔类型非常简单，常用的API和数值类型差不多，无非是`New()`和`Value()`两个，不同的是它们的参数或者返回值是一个`bool`类型罢了。

## 对象（Object）

对象继承自 `TaggedImpl`:

```c++
class Object : public TaggedImpl<HeapObjectReferenceType::STRONG, Address> { 
```

对象可以用它默认的构造函数创建或者传入一个指向TaggedImpl的构造函数的地址。对象本身不包括任何成员，除了一个继承自TaggedImpl的`ptr_`，所以我们创建的Object在栈上类似于一个指向对象的指针。

```
+------+
|Object|
|------|
|ptr_  |---->
+------+
```

`ptr_`是一个StrongType，所以它可以是一个`smi`，此时它会包含一个像小整数的值：

```
+------+
|Object|
|------|
|  18  |
+------+
```

测试代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include <bitset>
#include "src/objects/objects-inl.h"
#include "src/objects/slots.h"

namespace i = v8::internal;

TEST(Object, Create) {
  i::Object obj{};
  EXPECT_EQ(obj.ptr(), i::kNullAddress);
  i::Object obj2{18};
  EXPECT_EQ(static_cast<int>(obj2.ptr()), 18);
}
```

