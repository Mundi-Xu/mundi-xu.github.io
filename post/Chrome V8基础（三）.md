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

对象继承自 `TaggedImpl`，从`Object`出发，衍生了各种其他非元类型的数据类型，如数组、函数等：

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

### ObjectSlot

```c++
  i::Object obj{18};
  i::FullObjectSlot slot{&obj};
```

```
+----------+      +---------+
|ObjectSlot|      | Object  |
|----------|      |---------|
| address  | ---> |   18    |
+----------+      +---------+
```

样例代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8.h"
#include <bitset>
#include "src/objects/objects-inl.h"
#include "src/objects/slots.h"

namespace i = v8::internal;

TEST(ObjectSlot, Create) {
  i::Object obj{18};
  i::FullObjectSlot slot{&obj};
  EXPECT_NE(slot.address(), obj.ptr());
  EXPECT_EQ(*slot, obj);

  i::Object* p = &obj;
  i::Object** pp = &p;
  EXPECT_EQ(*slot, **pp);
}
```

### Maybe

`Maybe`是一个简单的用于表现一个对象是否具值的数据类型，当一个API返回一个`Maybe<>`时，就说明它可能是一个布尔值，也可能是一个因为异常而得到的无值结果。

```c++
template <class T>                                                              
class Maybe {
 public:
  V8_INLINE bool IsNothing() const { return !has_value_; }                      
  V8_INLINE bool IsJust() const { return has_value_; }
  ...

 private:
  bool has_value_;                                                              
  T value_; 
}
```

`Maybe<>`的数据类型有几个常用的函数：

+ `bool Maybe<T>::IsNothing() const` 是否具值
+ `bool Maybe<T>::IsJust() const` 与上面这个函数结果相反
+ `T Maybe<T>::FromJust() const` 返回它本体的值，如果不具值则直接崩溃
+ `T Maybe<T>::FromMaybe(const Maybe& default_value) const` 返回它本体的值，如果不具值则返回`default_value`

样例代码：

```c++
#include <iostream>
#include "gtest/gtest.h"
#include "v8_test_fixture.h"
#include "v8.h"

using namespace v8;

class MaybeTest : public V8TestFixture {
};

TEST_F(MaybeTest, Maybe) {
  bool cond = true;
  Maybe<int> maybe = cond ? Just<int>(10) : Nothing<int>();
  EXPECT_TRUE(maybe.IsJust());
  EXPECT_FALSE(maybe.IsNothing());
  maybe.Check();

  int nr = maybe.ToChecked();
  EXPECT_EQ(nr, 10);
  EXPECT_EQ(maybe.FromJust(), 10);

  Maybe<int> nothing = Nothing<int>();
  int value = nothing.FromMaybe(22);
  EXPECT_EQ(value, 22);
}

/*
 * I think the intention with a type Maybe<void> is that we don't really
 * care/want to have a value in the Maybe apart from that is is empty or
 * something. So instead of having a bool and setting it to true just
 * have void and return an empty. I think this signals the intent of a
 * function better as one might otherwise wonder what the value in the maybe
 * represents.
 */
Maybe<void> doit(int x) {
  if (x == -1) {
    return Nothing<void>();
  }
  return JustVoid();
}

TEST_F(MaybeTest, MaybeVoid) {
  Maybe<void> maybe = JustVoid();
  EXPECT_FALSE(maybe.IsNothing());

  Maybe<void> maybe_nothing = Nothing<void>();
  EXPECT_TRUE(maybe_nothing.IsNothing());

  EXPECT_TRUE(doit(-1).IsNothing());
  EXPECT_TRUE(doit(1).IsJust());
}
```

## 函数（Function）

别忘了函数也是对象的一种，所以说V8中的`Function`也是继承自`Object`的。对于外界传进来的`Value`类型的函数，读者能通过之前介绍过的`Local<T>::Cast`来将其转换成函数类型，也可以通过`CheckCast()`判断。

```c++
void v8::Function::CheckCast(Value* that) {
  i::Handle<i::Object> obj = Utils::OpenHandle(that);
  Utils::ApiCheck(obj->IsCallable(), "v8::Function::Cast",
                  "Value is not a Function");
}
```

而对于一个已经是函数类型的数据来说，我们可以用以下一些常见的函数：

+ `Call()` 调用这个函数
+ `NewInstance` 相当于通过`new`的方式调用这个函数以得到类的实例。
+ `Setname()` `GetName()` 设置获取函数名
+ 具体可以看`src/api/api.cc`

这里主要介绍一下如何调用一个函数的数据类型。

### 函数调用（Call）

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

各参数含义如下：

+ `context` 上下文
+ `recv` 相当于被调用函数内部的`this`
+ `argc` 这次函数调用的参数个数
+ `argv` 与参数个数对应的参数数组，以本地`Value`句柄的形式出现。

### 构造函数的实例化（NewInstance）

```c++
MaybeLocal<Object> Function::NewInstance(Local<Context> context, int argc,
                                         v8::Local<v8::Value> argv[]) const {
  return NewInstanceWithSideEffectType(context, argc, argv,
                                       SideEffectType::kHasSideEffect);
}
```

调用`NewInstanceWithSideEffectType()`生成

```c++
MaybeLocal<Object> Function::NewInstanceWithSideEffectType(
    Local<Context> context, int argc, v8::Local<v8::Value> argv[],
    SideEffectType side_effect_type) const {
  auto isolate = reinterpret_cast<i::Isolate*>(context->GetIsolate());
  TRACE_EVENT_CALL_STATS_SCOPED(isolate, "v8", "V8.Execute");
  ENTER_V8(isolate, context, Function, NewInstance, MaybeLocal<Object>(),
           InternalEscapableScope);
  i::TimerEventScope<i::TimerEventExecute> timer_scope(isolate);
  auto self = Utils::OpenHandle(this);
  STATIC_ASSERT(sizeof(v8::Local<v8::Value>) == sizeof(i::Handle<i::Object>));
  bool should_set_has_no_side_effect =
      side_effect_type == SideEffectType::kHasNoSideEffect &&
      isolate->debug_execution_mode() == i::DebugInfo::kSideEffects;
  if (should_set_has_no_side_effect) {
    CHECK(self->IsJSFunction() &&
          i::JSFunction::cast(*self).shared().IsApiFunction());
    i::Object obj =
        i::JSFunction::cast(*self).shared().get_api_func_data().call_code(
            kAcquireLoad);
    if (obj.IsCallHandlerInfo()) {
      i::CallHandlerInfo handler_info = i::CallHandlerInfo::cast(obj);
      if (!handler_info.IsSideEffectFreeCallHandlerInfo()) {
        handler_info.SetNextCallHasNoSideEffect();
      }
    }
  }
  i::Handle<i::Object>* args = reinterpret_cast<i::Handle<i::Object>*>(argv);
  Local<Object> result;
  has_pending_exception = !ToLocal<Object>(
      i::Execution::New(isolate, self, self, argc, args), &result);
  if (should_set_has_no_side_effect) {
    i::Object obj =
        i::JSFunction::cast(*self).shared().get_api_func_data().call_code(
            kAcquireLoad);
    if (obj.IsCallHandlerInfo()) {
      i::CallHandlerInfo handler_info = i::CallHandlerInfo::cast(obj);
      if (has_pending_exception) {
        // Restore the map if an exception prevented restoration.
        handler_info.NextCallHasNoSideEffect();
      } else {
        DCHECK(handler_info.IsSideEffectCallHandlerInfo() ||
               handler_info.IsSideEffectFreeCallHandlerInfo());
      }
    }
  }
  RETURN_ON_FAILED_EXECUTION(Object);
  RETURN_ESCAPED(result);
}
```

### 函数名操作(Name)

获取函数名：

```c++
Local<Value> Function::GetName() const {
  auto self = Utils::OpenHandle(this);
  i::Isolate* isolate = self->GetIsolate();
  if (self->IsJSBoundFunction()) {
    auto func = i::Handle<i::JSBoundFunction>::cast(self);
    i::Handle<i::Object> name;
    ASSIGN_RETURN_ON_EXCEPTION_VALUE(isolate, name,
                                     i::JSBoundFunction::GetName(isolate, func),
                                     Local<Value>());
    return Utils::ToLocal(name);
  }
  if (self->IsJSFunction()) {
    auto func = i::Handle<i::JSFunction>::cast(self);
    return Utils::ToLocal(handle(func->shared().Name(), isolate));
  }
  return ToApiHandle<Primitive>(isolate->factory()->undefined_value());
}
```

设置更改函数名：

```c++
void Function::SetName(v8::Local<v8::String> name) {
  auto self = Utils::OpenHandle(this);
  if (!self->IsJSFunction()) return;
  auto func = i::Handle<i::JSFunction>::cast(self);
  ASSERT_NO_SCRIPT_NO_EXCEPTION(func->GetIsolate());
  func->shared().SetName(*Utils::OpenHandle(*name));
}
```

还有一些特定用途（如Debug）的函数

```c++
Local<Value> Function::GetInferredName() const {
  auto self = Utils::OpenHandle(this);
  if (!self->IsJSFunction()) {
    return ToApiHandle<Primitive>(
        self->GetIsolate()->factory()->undefined_value());
  }
  auto func = i::Handle<i::JSFunction>::cast(self);
  return Utils::ToLocal(
      i::Handle<i::Object>(func->shared().inferred_name(), func->GetIsolate()));
}

Local<Value> Function::GetDebugName() const {
  auto self = Utils::OpenHandle(this);
  if (!self->IsJSFunction()) {
    return ToApiHandle<Primitive>(
        self->GetIsolate()->factory()->undefined_value());
  }
  auto func = i::Handle<i::JSFunction>::cast(self);
  i::Handle<i::String> name = i::JSFunction::GetDebugName(func);
  return Utils::ToLocal(i::Handle<i::Object>(*name, self->GetIsolate()));
}
```

## 数组（Array）

数组也继承自对象，通常在转换的时候由句柄的`As`函数来完成。

```c++
class V8_EXPORT Array : public Object {
 public:
  uint32_t Length() const;

  /**
   * Creates a JavaScript array with the given length. If the length
   * is negative the returned array will have length 0.
   */
  static Local<Array> New(Isolate* isolate, int length = 0);

  /**
   * Creates a JavaScript array out of a Local<Value> array in C++
   * with a known length.
   */
  static Local<Array> New(Isolate* isolate, Local<Value>* elements,
                          size_t length);
  V8_INLINE static Array* Cast(Value* obj);

 private:
  Array();
  static void CheckCast(Value* obj);
};
```

主要介绍一下`Array`的几个常用API：

### New

与对象不同的是，数组的`New`函数还可以多带一个参数，代表该数组的长度。

```c++
Local<v8::Array> v8::Array::New(Isolate* isolate, int length) {
  i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
  LOG_API(i_isolate, Array, New);
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(i_isolate);
  int real_length = length > 0 ? length : 0;
  i::Handle<i::JSArray> obj = i_isolate->factory()->NewJSArray(real_length);
  i::Handle<i::Object> length_obj =
      i_isolate->factory()->NewNumberFromInt(real_length);
  obj->set_length(*length_obj);
  return Utils::ToLocal(obj);
}

Local<v8::Array> v8::Array::New(Isolate* isolate, Local<Value>* elements,
                                size_t length) {
  i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
  i::Factory* factory = i_isolate->factory();
  LOG_API(i_isolate, Array, New);
  ENTER_V8_NO_SCRIPT_NO_EXCEPTION(i_isolate);
  int len = static_cast<int>(length);

  i::Handle<i::FixedArray> result = factory->NewFixedArray(len);
  for (int i = 0; i < len; i++) {
    i::Handle<i::Object> element = Utils::OpenHandle(*elements[i]);
    result->set(i, *element);
  }

  return Utils::ToLocal(
      factory->NewJSArrayWithElements(result, i::PACKED_ELEMENTS, len));
}
```

### Set与Get

主要使用下标的形式来设置和获取

### Length

获取数组的长度：

```c++
uint32_t v8::Array::Length() const {
  i::Handle<i::JSArray> obj = Utils::OpenHandle(this);
  i::Object length = obj->length();
  if (length.IsSmi()) {
    return i::Smi::ToInt(length);
  } else {
    return static_cast<uint32_t>(length.Number());
  }
}
```

## JSON解析器

Chrome V8的JSON解析器也充满了黑科技，它在V8中是一个类：

```c++\
class V8_EXPORT JSON {
 public:
  /**
   * Tries to parse the string |json_string| and returns it as value if
   * successful.
   *
   * \param the context in which to parse and create the value.
   * \param json_string The string to parse.
   * \return The corresponding value if successfully parsed.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Value> Parse(
      Local<Context> context, Local<String> json_string);

  /**
   * Tries to stringify the JSON-serializable object |json_object| and returns
   * it as string if successful.
   *
   * \param json_object The JSON-serializable object to stringify.
   * \return The corresponding string if successfully stringified.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> Stringify(
      Local<Context> context, Local<Value> json_object,
      Local<String> gap = Local<String>());
};
```

主要使用`Parse`和`Stringify`

```c++
MaybeLocal<Value> JSON::Parse(Local<Context> context,
                              Local<String> json_string) {
  PREPARE_FOR_EXECUTION(context, JSON, Parse, Value);
  i::Handle<i::String> string = Utils::OpenHandle(*json_string);
  i::Handle<i::String> source = i::String::Flatten(isolate, string);
  i::Handle<i::Object> undefined = isolate->factory()->undefined_value();
  auto maybe = source->IsOneByteRepresentation()
                   ? i::JsonParser<uint8_t>::Parse(isolate, source, undefined)
                   : i::JsonParser<uint16_t>::Parse(isolate, source, undefined);
  Local<Value> result;
  has_pending_exception = !ToLocal<Value>(maybe, &result);
  RETURN_ON_FAILED_EXECUTION(Value);
  RETURN_ESCAPED(result);
}

MaybeLocal<String> JSON::Stringify(Local<Context> context,
                                   Local<Value> json_object,
                                   Local<String> gap) {
  PREPARE_FOR_EXECUTION(context, JSON, Stringify, String);
  i::Handle<i::Object> object = Utils::OpenHandle(*json_object);
  i::Handle<i::Object> replacer = isolate->factory()->undefined_value();
  i::Handle<i::String> gap_string = gap.IsEmpty()
                                        ? isolate->factory()->empty_string()
                                        : Utils::OpenHandle(*gap);
  i::Handle<i::Object> maybe;
  has_pending_exception =
      !i::JsonStringify(isolate, object, replacer, gap_string).ToHandle(&maybe);
  RETURN_ON_FAILED_EXECUTION(String);
  Local<String> result;
  has_pending_exception =
      !ToLocal<String>(i::Object::ToString(isolate, maybe), &result);
  RETURN_ON_FAILED_EXECUTION(String);
  RETURN_ESCAPED(result);
}
```

# 异常机制

`TryCatch`是V8中一个捕获异常的类，管理其生命周期中V8层面异常。

```c++
class V8_EXPORT TryCatch {
 public:
  /**
   * Creates a new try/catch block and registers it with v8.  Note that
   * all TryCatch blocks should be stack allocated because the memory
   * location itself is compared against JavaScript try/catch blocks.
   */
  explicit TryCatch(Isolate* isolate);

  /**
   * Unregisters and deletes this try/catch block.
   */
  ~TryCatch();

  /**
   * Returns true if an exception has been caught by this try/catch block.
   */
  bool HasCaught() const;

  /**
   * For certain types of exceptions, it makes no sense to continue execution.
   *
   * If CanContinue returns false, the correct action is to perform any C++
   * cleanup needed and then return.  If CanContinue returns false and
   * HasTerminated returns true, it is possible to call
   * CancelTerminateExecution in order to continue calling into the engine.
   */
  bool CanContinue() const;

  /**
   * Returns true if an exception has been caught due to script execution
   * being terminated.
   *
   * There is no JavaScript representation of an execution termination
   * exception.  Such exceptions are thrown when the TerminateExecution
   * methods are called to terminate a long-running script.
   *
   * If such an exception has been thrown, HasTerminated will return true,
   * indicating that it is possible to call CancelTerminateExecution in order
   * to continue calling into the engine.
   */
  bool HasTerminated() const;

  /**
   * Throws the exception caught by this TryCatch in a way that avoids
   * it being caught again by this same TryCatch.  As with ThrowException
   * it is illegal to execute any JavaScript operations after calling
   * ReThrow; the caller must return immediately to where the exception
   * is caught.
   */
  Local<Value> ReThrow();

  /**
   * Returns the exception caught by this try/catch block.  If no exception has
   * been caught an empty handle is returned.
   */
  Local<Value> Exception() const;

  /**
   * Returns the .stack property of an object.  If no .stack
   * property is present an empty handle is returned.
   */
  V8_WARN_UNUSED_RESULT static MaybeLocal<Value> StackTrace(
      Local<Context> context, Local<Value> exception);

  /**
   * Returns the .stack property of the thrown object.  If no .stack property is
   * present or if this try/catch block has not caught an exception, an empty
   * handle is returned.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> StackTrace(
      Local<Context> context) const;

  /**
   * Returns the message associated with this exception.  If there is
   * no message associated an empty handle is returned.
   */
  Local<v8::Message> Message() const;

  /**
   * Clears any exceptions that may have been caught by this try/catch block.
   * After this method has been called, HasCaught() will return false. Cancels
   * the scheduled exception if it is caught and ReThrow() is not called before.
   *
   * It is not necessary to clear a try/catch block before using it again; if
   * another exception is thrown the previously caught exception will just be
   * overwritten.  However, it is often a good idea since it makes it easier
   * to determine which operation threw a given exception.
   */
  void Reset();

  /**
   * Set verbosity of the external exception handler.
   *
   * By default, exceptions that are caught by an external exception
   * handler are not reported.  Call SetVerbose with true on an
   * external exception handler to have exceptions caught by the
   * handler reported as if they were not caught.
   */
  void SetVerbose(bool value);

  /**
   * Returns true if verbosity is enabled.
   */
  bool IsVerbose() const;

  /**
   * Set whether or not this TryCatch should capture a Message object
   * which holds source information about where the exception
   * occurred.  True by default.
   */
  void SetCaptureMessage(bool value);

  /**
   * There are cases when the raw address of C++ TryCatch object cannot be
   * used for comparisons with addresses into the JS stack. The cases are:
   * 1) ARM, ARM64 and MIPS simulators which have separate JS stack.
   * 2) Address sanitizer allocates local C++ object in the heap when
   *    UseAfterReturn mode is enabled.
   * This method returns address that can be used for comparisons with
   * addresses into the JS stack. When neither simulator nor ASAN's
   * UseAfterReturn is enabled, then the address returned will be the address
   * of the C++ try catch handler itself.
   */
  static void* JSStackComparableAddress(TryCatch* handler) {
    if (handler == nullptr) return nullptr;
    return handler->js_stack_comparable_address_;
  }

  TryCatch(const TryCatch&) = delete;
  void operator=(const TryCatch&) = delete;

 private:
  // Declaring operator new and delete as deleted is not spec compliant.
  // Therefore declare them private instead to disable dynamic alloc
  void* operator new(size_t size);
  void* operator new[](size_t size);
  void operator delete(void*, size_t);
  void operator delete[](void*, size_t);

  void ResetInternal();

  internal::Isolate* isolate_;
  TryCatch* next_;
  void* exception_;
  void* message_obj_;
  void* js_stack_comparable_address_;
  bool is_verbose_ : 1;
  bool can_continue_ : 1;
  bool capture_message_ : 1;
  bool rethrow_ : 1;
  bool has_terminated_ : 1;

  friend class internal::Isolate;
};
```

主要的API如下：

+ `TryCatch()` 构造函数传入的是`Isolate*`指针
+ `bool HasCaught()` 是否有错误被该`TryCatch`域捕获
+ `Local<Value> Exception()` 返回一个`Exception`对象，代表捕获的错误实体。
+ ` Local<Value> ReThrow();` 重新将其捕获的错误通过`throw`抛出去

异常生成的类叫`Exception`类：

```c++

class V8_EXPORT Exception {
 public:
  static Local<Value> RangeError(Local<String> message);
  static Local<Value> ReferenceError(Local<String> message);
  static Local<Value> SyntaxError(Local<String> message);
  static Local<Value> TypeError(Local<String> message);
  static Local<Value> WasmCompileError(Local<String> message);
  static Local<Value> WasmLinkError(Local<String> message);
  static Local<Value> WasmRuntimeError(Local<String> message);
  static Local<Value> Error(Local<String> message);

  /**
   * Creates an error message for the given exception.
   * Will try to reconstruct the original stack trace from the exception value,
   * or capture the current stack trace if not available.
   */
  static Local<Message> CreateMessage(Isolate* isolate, Local<Value> exception);

  /**
   * Returns the original stack trace that was captured at the creation time
   * of a given exception, or an empty handle if not available.
   */
  static Local<StackTrace> GetStackTrace(Local<Value> exception);
};
```

# 小结

本节介绍了Chrome V8的一些基本数据类型和异常处理，其API均能在文档中找到。
