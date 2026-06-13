# `react-native-worklets` `__remoteFunctionRegistry` leak — minimal repro

A non-worklet JS function captured into a worklet closure is registered in the global
`__remoteFunctionRegistry` and **never removed**. The registry grows monotonically for the
lifetime of the JS runtime — not after the worklet is dropped, not after the owning
component unmounts, not under GC pressure. The JS heap ratchets and Hermes GC cost climbs
until the whole app is uniformly slow; only a JS reload (fresh heap) restores speed.

This is a bare React Native project that makes the leak directly observable: a live
`__remoteFunctionRegistry.size` readout plus buttons that grow it.

> **You are on the `patched` branch.** It carries the fix as a native **pnpm patch**
> (`pnpm-workspace.yaml` → `patches/react-native-worklets+0.9.1.patch`), applied automatically at
> `pnpm install` with **no `postinstall` script**. Installed and run here, the registry **drops
> back toward baseline on GC** instead of leaking. For the unpatched leak, check out `main`. See
> [Testing the fix](#testing-the-fix).

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

## Testing the fix

The fix is one change to `react-native-worklets`: `serializableMappingCache` stores its values as `WeakRef` instead of strong references, so a strongly-held key (a callback pinned by `__remoteFunctionRegistry`, or a worklet `fun` pinned by a React ref) no longer pins the holder that owns the `SerializableRemoteFunction` `shared_ptr`. The destructor can then run and prune the registry entry — turning a permanent leak into ordinary GC-reclaimable memory.

### How it's applied (no install script)

`pnpm install` applies the patch automatically via `pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  react-native-worklets@0.9.1: patches/react-native-worklets+0.9.1.patch
```

pnpm patches the dependency natively at install time — there is **no `postinstall` script**, so it also works under `--ignore-scripts`. Confirm the patch is active:

```sh
grep -c "LEAK FIX" node_modules/react-native-worklets/src/memory/serializableMappingCache.native.ts
# → 1   (pnpm-lock.yaml also records it under patchedDependencies)
```

### Verify the registry now drains

Run the app and watch `registry.size`. Unlike `main`, the entries are reclaimed on GC:

| Steps | Result |
| --- | --- |
| **1. Serialize 200** → **3. GC pressure (JS runtime)** *and* **3b. UI-thread GC pressure** | one-shot entries drop back toward baseline |
| **2. Mount 200 → …unmount** → **3b. UI-thread GC pressure** | mapper entries drop back toward baseline |
| Animation **canary** (top-right square) | keeps pulsing — persistent worklets unaffected |

An entry is freed only once *every* holder of its `shared_ptr` is collected, and those holders can live on either runtime. The one-shot path runs its worklet on the UI thread, so it has a holder on **both** the JS and UI runtimes — it needs a GC on **both** to drain. The mapper path clears on a **UI**-runtime GC. DevTools' "collect garbage" only touches the JS runtime, which is why there's a dedicated UI-thread GC button. Under normal app use both runtimes GC on their own, so the registry stays bounded instead of growing forever.

### A/B against the leak

```sh
git checkout main    && pnpm install   # unpatched → registry climbs, never drops
git checkout patched && pnpm install   # patched   → registry drops on GC
```

## What you should see (unpatched — i.e. `main`)

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

There is a **second, RN-side pin** as well: `serializableMappingCache`
(`src/memory/serializableMappingCache.native.ts`) is a `WeakMap` keyed by the original
function/worklet, but its **values are strong**. A `WeakMap` only weakly references its *keys*,
so a key kept alive by something else — a callback pinned by `__remoteFunctionRegistry`, or a
worklet `fun` pinned by a React ref (e.g. `useAnimatedStyle`'s `styleUpdaterContainer.current`)
— pins its holder value forever, holding the `shared_ptr` independently of the UI runtime.

**The fix on this branch weakens that cache** (store values via `WeakRef`). The holder then
becomes collectable once no live worklet needs it; collecting it frees the
`RetainingSerializable` (and with it `secondaryValue_`), the destructor runs, and
`registry.delete(id)` finally fires. One localized change clears both the RN-side and UI-side
pins. See [Testing the fix](#testing-the-fix).

## The fix (this branch's patch)

One file changes — `react-native-worklets/src/memory/serializableMappingCache.native.ts`. The dedup cache stops pinning its values by storing them as `WeakRef`:

```diff
-const cache = new WeakMap<object, SerializableRef | symbol>();
+const cache = new WeakMap<object, WeakRef<object> | symbol>();

 export const serializableMappingCache = {
   set(serializable, serializableRef) {
-    cache.set(serializable, serializableRef || serializableMappingFlag);
+    cache.set(serializable, serializableRef ? new WeakRef(serializableRef) : serializableMappingFlag);
   },
-  get: cache.get.bind(cache),
+  get(serializable) {
+    const entry = cache.get(serializable);
+    if (entry === undefined || entry === serializableMappingFlag) return entry;
+    return entry.deref();   // undefined if the holder was GC'd → caller re-serializes
+  },
 };
```

A `WeakMap` only weakly references its **keys**; here the **values** were strong. That is what let a registry-pinned callback (or a worklet `fun` held by a React ref) keep its holder — and the holder's `shared_ptr<SerializableRemoteFunction>` — alive forever. Storing the value as a `WeakRef` lets the holder be collected once nothing else references it; the destructor then runs and `registry.delete(id)` finally fires. One localized change clears both the RN-side cache pin and (transitively, by letting the `RetainingSerializable` die) the UI-side `secondaryValue_` pin.

Dedup is preserved while a holder is alive — the common case of several concurrently-live worklets capturing the same function still share one holder. The only behavioural change: if a holder has already been collected and the same source is captured again, `get()` returns `undefined` and the value is re-serialized (a fresh id/entry — itself collectable). That's lost-dedup overhead on a cold path, not a leak.

The complete patch (with the explanatory comment) is `patches/react-native-worklets+0.9.1.patch`, applied at install via pnpm — see [Testing the fix](#testing-the-fix).

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
