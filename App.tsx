/**
 * react-native-worklets `__remoteFunctionRegistry` leak — minimal repro.
 *
 * Stack (pinned to match the app that hit this in production):
 *   react-native 0.85.3 · react 19.2.3
 *   react-native-reanimated 4.4.1 · react-native-worklets 0.9.1
 *
 * THE BUG
 * -------
 * Every NON-worklet JS function captured into a worklet closure is serialized by
 * worklets as a "remote function" and registered in the global
 * `__remoteFunctionRegistry` (a plain Map<number, Function>, NOT a WeakMap) so the
 * UI runtime can call back into it. Registry entries are deleted ONLY by the C++
 * `SerializableRemoteFunction::~SerializableRemoteFunction()` destructor, which
 * schedules `registry.delete(id)`. In practice that destructor never runs — the
 * shared_ptr is pinned (see README "Retention chain"). So the registry grows
 * monotonically and NEVER shrinks: not after the worklet is dropped, not after the
 * owning component unmounts, not under GC pressure. The JS heap ratchets and Hermes
 * GC cost climbs until the whole app is slow; a JS reload (fresh heap) "fixes" it.
 *
 * This screen makes the leak observable with a live `__remoteFunctionRegistry.size`
 * readout and three ways to grow it. Watch the size climb and never come back down.
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {runOnJS, runOnUI} from 'react-native-worklets';

const BATCH = 200;

// ---------------------------------------------------------------------------
// Registry probe
// ---------------------------------------------------------------------------

type RegistryGlobal = {__remoteFunctionRegistry?: Map<number, unknown>};

function registrySize(): number {
  const reg = (globalThis as RegistryGlobal).__remoteFunctionRegistry;
  return reg ? reg.size : -1;
}

// ---------------------------------------------------------------------------
// Leak path 1 — direct: serialize N worklets, each capturing a FRESH JS callback,
// then drop every reference. No React, no components. The cleanest proof that the
// entry's lifetime is decoupled from anything we hold: we keep nothing, the
// registry keeps everything.
// ---------------------------------------------------------------------------

function serializeBatch(n: number): void {
  for (let i = 0; i < n; i++) {
    // A fresh function identity every iteration. serializableMappingCache is keyed
    // by function identity, so each one is serialized (and registered) anew.
    const cb = () => {};
    // Capturing `cb` inside the worklet closure is what registers it as a remote
    // function. runOnUI serializes the worklet (and its closure) on every call.
    runOnUI(() => {
      'worklet';
      // Reference cb so the babel plugin captures it into __closure. Guarded so we
      // don't actually flood the JS thread with 200 callbacks per press.
      if (cb === undefined) {
        runOnJS(cb)();
      }
    })();
    // `cb` and the worklet go out of scope here — nothing in JS references them.
  }
}

// ---------------------------------------------------------------------------
// Leak path 2 — realistic: a mounted Animated node whose useAnimatedStyle worklet
// captures a per-mount JS callback. This is how normal apps leak (gesture/animated
// callbacks). Unmounting the node does NOT free the entry.
// ---------------------------------------------------------------------------

function LeakerNode(): React.JSX.Element {
  // Fresh per-mount JS function identity.
  const onTick = useMemo(() => () => {}, []);
  const style = useAnimatedStyle(() => {
    // Reference onTick so it is captured into the worklet closure and serialized
    // as a remote function — the thing that leaks. `void` keeps it a genuine
    // reference (so babel captures it) without calling it.
    void onTick;
    return {opacity: 1};
  });
  return <Animated.View style={[styles.dot, style]} />;
}

// ---------------------------------------------------------------------------
// Animation canary — a VISIBLE persistent-worklet (useAnimatedStyle + withRepeat).
// Used to check the fix experiment doesn't break long-lived worklets: if the patch
// (honor shouldPersistRemote → animated worklets become non-retaining) breaks them,
// this box stops pulsing.
// ---------------------------------------------------------------------------

function AnimationCanary({color}: {color: string}): React.JSX.Element {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, {duration: 700}), -1, true);
  }, [t]);
  const style = useAnimatedStyle(() => ({opacity: 0.15 + 0.85 * t.value}));
  return <Animated.View style={[styles.canary, {backgroundColor: color}, style]} />;
}

// ---------------------------------------------------------------------------
// GC pressure — allocate and drop a lot, plus call global.gc() if exposed. Shows
// the retention is a strong reference in the serializable lifecycle, not GC laziness.
// ---------------------------------------------------------------------------

function gcPressure(): void {
  for (let round = 0; round < 20; round++) {
    let junk: number[][] | null = [];
    for (let i = 0; i < 200; i++) {
      junk.push(new Array(10000).fill(i));
    }
    junk = null;
  }
  const g = globalThis as {gc?: () => void};
  if (typeof g.gc === 'function') {
    g.gc();
  }
}

// Force GC on the UI (worklet) runtime — a SEPARATE Hermes heap that DevTools'
// "collect garbage" does not touch. The mapper (useAnimatedStyle) worklet lives
// here, so its captured remote function's shared_ptr is released only when the UI
// runtime collects it. This runs the same allocation pressure on the UI thread.
function uiGcPressure(): void {
  runOnUI(() => {
    'worklet';
    for (let round = 0; round < 20; round++) {
      let junk: number[][] | null = [];
      for (let i = 0; i < 200; i++) {
        junk.push(new Array(10000).fill(i));
      }
      junk = null;
    }
    const g = globalThis as {gc?: () => void};
    if (typeof g.gc === 'function') {
      g.gc();
    }
  })();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function App(): React.JSX.Element {
  const dark = useColorScheme() === 'dark';
  const [size, setSize] = useState<number>(registrySize());
  const [baseline, setBaseline] = useState<number | null>(null);
  const [serialized, setSerialized] = useState(0);
  const [mounted, setMounted] = useState(0);

  // Live readout: poll the registry size twice a second.
  useEffect(() => {
    const id = setInterval(() => {
      const s = registrySize();
      setSize(s);
      setBaseline(prev => (prev === null && s >= 0 ? s : prev));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const onSerialize = useCallback(() => {
    serializeBatch(BATCH);
    setSerialized(prev => prev + BATCH);
  }, []);

  const onMount = useCallback(() => setMounted(prev => prev + BATCH), []);
  const onUnmount = useCallback(() => setMounted(0), []);
  const onGc = useCallback(() => {
    gcPressure();
    setSize(registrySize());
  }, []);
  const onUiGc = useCallback(() => {
    uiGcPressure();
    // give the UI-runtime GC + cross-thread registry.delete a moment to land
    setTimeout(() => setSize(registrySize()), 1200);
  }, []);
  const onRebase = useCallback(() => setBaseline(registrySize()), []);

  const delta = baseline === null ? size : size - baseline;
  const c = dark ? darkColors : lightColors;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.fill, {backgroundColor: c.bg}]}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.title, {color: c.text}]}>
            worklets __remoteFunctionRegistry leak
          </Text>
          <View style={styles.headerRow}>
            <Text style={[styles.sub, {color: c.subtle}]}>
              reanimated 4.4.1 · worklets 0.9.1 · RN 0.85.3
            </Text>
            {/* canary: must keep pulsing for persistent worklets to be OK */}
            <AnimationCanary color={c.accent} />
          </View>

          <View style={[styles.card, {backgroundColor: c.card}]}>
            <Stat label="registry.size" value={fmt(size)} color={c.text} big />
            <Stat
              label="Δ since baseline"
              value={(delta >= 0 ? '+' : '') + delta}
              color={delta > 0 ? c.bad : c.text}
            />
            <Stat label="baseline" value={fmt(baseline)} color={c.subtle} />
            <Stat
              label="serialized by us"
              value={String(serialized)}
              color={c.subtle}
            />
            <Stat
              label="nodes mounted"
              value={String(mounted)}
              color={c.subtle}
            />
          </View>

          <Btn
            label={`1. Serialize ${BATCH} worklets (drop refs)`}
            onPress={onSerialize}
            c={c}
          />
          <Btn
            label={`2. Mount ${BATCH} animated nodes`}
            onPress={onMount}
            c={c}
          />
          <Btn label="   …then unmount them all" onPress={onUnmount} c={c} />
          <Btn label="3. GC pressure (JS runtime)" onPress={onGc} c={c} />
          <Btn label="3b. UI-thread GC pressure" onPress={onUiGc} c={c} />
          <Btn label="Reset baseline" onPress={onRebase} c={c} subtle />

          <Text style={[styles.note, {color: c.subtle}]}>
            Expected (no leak): after dropping refs / unmounting / GC, size returns
            toward baseline. Actual (the bug): size only ever climbs.
          </Text>
        </ScrollView>

        {/* Mounted leaker nodes live here (kept tiny / off to the side). */}
        <View style={styles.stage} pointerEvents="none">
          {Array.from({length: mounted}, (_, i) => (
            <LeakerNode key={i} />
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

function Stat({
  label,
  value,
  color,
  big,
}: {
  label: string;
  value: string;
  color: string;
  big?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, {color}]}>{label}</Text>
      <Text style={[big ? styles.statBig : styles.statVal, {color}]}>
        {value}
      </Text>
    </View>
  );
}

function Btn({
  label,
  onPress,
  c,
  subtle,
}: {
  label: string;
  onPress: () => void;
  c: typeof lightColors;
  subtle?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [
        styles.btn,
        {backgroundColor: subtle ? c.card : c.accent, opacity: pressed ? 0.7 : 1},
      ]}>
      <Text style={[styles.btnText, {color: subtle ? c.text : c.onAccent}]}>
        {label}
      </Text>
    </Pressable>
  );
}

const lightColors = {
  bg: '#f2f2f7',
  card: '#ffffff',
  text: '#111111',
  subtle: '#6b6b70',
  accent: '#0a84ff',
  onAccent: '#ffffff',
  bad: '#d92d20',
};
const darkColors: typeof lightColors = {
  bg: '#000000',
  card: '#1c1c1e',
  text: '#f2f2f7',
  subtle: '#9a9aa0',
  accent: '#0a84ff',
  onAccent: '#ffffff',
  bad: '#ff6b5e',
};

const styles = StyleSheet.create({
  fill: {flex: 1},
  content: {padding: 20, gap: 12},
  title: {fontSize: 20, fontWeight: '700'},
  sub: {fontSize: 13, marginTop: -6},
  card: {borderRadius: 14, padding: 16, gap: 8},
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  statLabel: {fontSize: 14},
  statVal: {fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums']},
  statBig: {fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums']},
  btn: {borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16},
  btnText: {fontSize: 15, fontWeight: '600'},
  note: {fontSize: 13, lineHeight: 19, marginTop: 8},
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -6,
  },
  canary: {width: 36, height: 36, borderRadius: 8},
  stage: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
  dot: {width: 1, height: 1},
});

export default App;
