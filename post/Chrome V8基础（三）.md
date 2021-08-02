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

