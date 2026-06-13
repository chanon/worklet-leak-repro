# `react-native-worklets` `__remoteFunctionRegistry` leak — minimal repro

A non-worklet JS function captured into a worklet closure is registered in the global
`__remoteFunctionRegistry` and **never removed**. The registry grows monotonically for the
lifetime of the JS runtime — not after the worklet is dropped, not after the owning
component unmounts, not under GC pressure. The JS heap ratchets and Hermes GC cost climbs
until the whole app is uniformly slow; only a JS reload (fresh heap) restores speed.

This is a bare React Native project that makes the leak directly observable: a live
`__remoteFunctionRegistry.size` readout plus three buttons that grow it. Watch the size
climb and never come back down.

## Versions (pinned)

| package | version |
| --- | --- |
| react-native | 0.85.3 |
| react | 19.2.3 |
| react-native-reanimated | 4.4.1 |
| react-native-worklets | 0.9.1 |
| Hermes | bundled with RN 0.85.3 (New Architecture / bridgeless) |

`react-native-worklets` `0.9.2` does **not** fix the leak.

## Run

This project uses **pnpm** (an `.npmrc` sets `node-linker=hoisted` so React Native's Metro resolver, community-CLI autolinking, and CocoaPods get the flat `node_modules` they expect). Install pnpm first if needed: `npm i -g pnpm` (or `corepack enable`).

```sh
pnpm install
# iOS
cd ios && pod install && cd ..
pnpm ios            # or: open ios/WorkletLeakRepro.xcworkspace in Xcode and Run
# Android
pnpm android
```

Then start Metro (if it isn't already): `pnpm start`. To observe the registry live, open React Native DevTools (Dev Menu → "Open DevTools") and use the Console: `globalThis.__remoteFunctionRegistry.size`.

## What you should see

The app shows `registry.size`, a baseline captured at first paint, and the delta. Then:

1. **`Serialize 200 worklets (drop refs)`** — runs a loop that creates 200 worklets, each
   capturing a *fresh* JS callback, schedules them on the UI runtime, and drops every JS
   reference. `registry.size` jumps by ~200.
2. **`Mount 200 animated nodes`** then **`…unmount them all`** — mounts 200 `Animated.View`s,
   each with a `useAnimatedStyle` worklet capturing a per-mount JS callback, then unmounts
   them all. `registry.size` jumps by ~200 on mount and **does not drop on unmount**.
3. **`GC pressure`** — allocates and drops ~tens of MB (and calls `global.gc()` if exposed).
   `registry.size` does not drop.

**Expected, if there were no leak:** after dropping refs / unmounting / GC, the size returns
toward baseline. **Actual:** the size only ever climbs. Press repeatedly to watch it ratchet
(68 MB → 300+ MB of JS heap in the real app this was distilled from, with GC eventually
eating ~40% of wall-clock time).

> Note on `global.gc()`: Hermes only exposes it when started with a specific flag, so the
> repro does not rely on it — the bulk allocation/drop loop forces real GC cycles regardless.
> The point is that *even after a real GC*, the registry is unchanged: the retention is a
> live strong reference, not GC laziness.

## Where the entries come from

`react-native-worklets/src/memory/serializable.native.ts` → `cloneNonWorkletFunction`: when a
non-worklet function is captured into a worklet closure it is registered with `__keepAlive`:

```ts
if ((clone as RegisteredRemoteFunction).__keepAlive) {
  registerRemoteFunction(fun);   // adds to __remoteFunctionRegistry
}
```

`registerRemoteFunction` (`src/memory/remoteFunctionRegistry.native.ts`) inserts into a plain
`Map<number, Function>` exposed as `globalThis.__remoteFunctionRegistry` — **not** a `WeakMap`,
so an entry lives until something explicitly calls `registry.delete(id)`.

The *only* thing that ever calls `delete` is the C++ destructor
`SerializableRemoteFunction::~SerializableRemoteFunction()`
(`Common/cpp/worklets/SharedItems/Serializable.cpp`):

```cpp
SerializableRemoteFunction::~SerializableRemoteFunction() {
  if (isHostedOnRNRuntime()) {
    const auto &data = std::get<RNRuntimeData>(runtimeData_);
    data.jsScheduler->scheduleOnJS([id = data.remoteId](jsi::Runtime &rt) {
      const auto registry = getRemoteFunctionRegistry(rt);
      registry.getPropertyAsFunction(rt, "delete").callWithThis(rt, registry, jsi::Value(id));
    });
  } else { /* ... */ }
}
```

**This destructor never runs**, because the `shared_ptr<SerializableRemoteFunction>` is pinned.

## Retention chain (why the `shared_ptr` never reaches refcount 0)

All references are to `react-native-worklets@0.9.1` as shipped inside
`react-native-reanimated@4.4.1`.

1. **Worklets are created as persistent, unconditionally.** `cloneWorklet`
   (`src/memory/serializable.native.ts`) calls `createSerializableWorklet(clonedProps, true)` —
   the `true` ("retain all worklets") makes the worklet a
   `RetainingSerializable<SerializableWorklet>`.
2. **`RetainingSerializable` caches the whole closure JS object graph on the UI runtime.**
   (`Common/cpp/worklets/SharedItems/Serializable.h`)

   ```cpp
   jsi::Value toJSValue(jsi::Runtime &rt) override {
     // ...
     if (secondaryValue_ == nullptr) {
       auto value = BaseClass::toJSValue(rt);            // builds worklet JS object + closure
       secondaryValue_ = std::make_unique<jsi::Value>(rt, value);  // holds it forever
       secondaryRuntime_ = &rt;
       return value;
     }
     // ...
   }
   ```

   `secondaryValue_` is a `unique_ptr<jsi::Value>` holding a JSI handle to the worklet's entire
   closure object graph on the UI runtime — kept until the `RetainingSerializable` itself dies.
3. **The closure graph contains the remote function's holder object**, whose JSI `NativeState`
   is a `SerializableJSRef` that holds `shared_ptr<SerializableRemoteFunction>`
   (`Serializable.cpp` `SerializableRemoteFunction::toJSValue`):

   ```cpp
   auto holderFunction = getRemoteFunctionUnpacker(rt).call(rt, name).getObject(rt);
   holderFunction.setNativeState(rt, std::make_shared<SerializableJSRef>(shared_from_this()));
   ```

   and `SerializableJSRef` (`Serializable.h`):

   ```cpp
   class SerializableJSRef : public jsi::NativeState {
     const std::shared_ptr<Serializable> value_;   // strong ref to the SerializableRemoteFunction
   };
   ```

**Chain:** `RetainingSerializable::secondaryValue_` (UI-runtime JSI handle) → worklet closure JS
object → holder function object → `NativeState` = `SerializableJSRef` →
`shared_ptr<SerializableRemoteFunction>`. As long as the worklet's `RetainingSerializable`
lives, that `shared_ptr` is held, so `~SerializableRemoteFunction()` is never called, so
`registry.delete(id)` is never scheduled, so the entry is immortal — and with it the captured
JS function and its entire closure environment.

The broken link to fix upstream is step 1/2: worklets are retained unconditionally, and the
retained UI-side closure handle keeps every captured remote function's `shared_ptr` alive for
the life of the worklet runtime.

## Application-side workaround (for reference)

Until upstream fixes the lifecycle, the leak is avoidable by never letting a worklet capture a
per-render / per-mount JS function:

- Route worklet→JS calls through a **single module-level dispatcher** that captures only a
  numeric id, so the closure holds no per-instance function (one registry entry for the app's
  lifetime).
- Or give the captured function a **permanent per-mount identity** (a ref-backed stable
  callback) so the serialization cache (keyed by function identity) reuses one entry instead of
  leaking one per re-render.

## Upstream references

- remoteFunction memory-model refactor that introduced this registry model:
  https://github.com/software-mansion/react-native-reanimated/pull/9272
- HermesRuntime / serializable retention scaling with worklet activity (likely the same
  lifecycle bug from the native side):
  https://github.com/software-mansion/react-native-reanimated/issues/9438
- separate import-time native RAM regression on RN 0.85.3 / Hermes (not this leak, same stack):
  https://github.com/software-mansion/react-native-reanimated/issues/9650
