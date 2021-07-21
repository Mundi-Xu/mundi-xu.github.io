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

最后，当HandleScope的析构函数被调用时，这些在这个句柄作用域中被创建的句柄和对象如果没有其他地方有引用的话，就会在下一次垃圾回收的时候被处理掉。不过我们创建的那个持久句柄并不会在析构时被动手，我们只能显式的调用Reset清除它。

## 可逃句柄作用域（Escapable Handle Scope）

根据上文所说，如果一个函数有一个 HandleScope 并且想要返回一个本地句柄，它在函数返回后将不可用。这就是`EscapableHandleScope`的作用了，它有一个`Escape`函数，可以给一个句柄以豁免权，将其复制到一个封闭的作用域中并删除其他的本地句柄，然后返回这个新复制的可以安全返回的句柄。

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

# 小结

句柄作用域就是管理句柄的一种类，它以栈的形式一层一层套着，存在于Isolate实例中，栈顶的作用域是当前活动作用域，每次新建对象时得到的句柄都会与当前活动作用域绑定。当活动作用域被析构时（通常是句柄作用域所处的C++作用域结束导致生命周期到期所致），与其绑定的所有句柄都会被回收，除可逃句柄作用域所设置的已逃脱句柄。

本节还介绍了V8中的两个重要模板类型————函数模板和对象模板，这两个模板很大意义上是相辅相成的。