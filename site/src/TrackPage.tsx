import { resolveRef, trackIn, tracks, type Item } from "./data.ts";
import { useProgress } from "./progress.ts";
import { ItemRow, inTrack } from "./Home.tsx";
import { TrackIcon } from "./icons.tsx";
import { useT } from "./i18n.tsx";
import { useSettings } from "./settings.ts";

const hours = (minutes: number) => Math.round(minutes / 6) / 10; // one decimal, so "left" can never exceed the total

export function TrackPage({ id }: { id: string }) {
  const { done } = useProgress();
  const t = useT();
  const { lang } = useSettings();
  const base = tracks.find((x) => x.id === id);
  const track = base && trackIn(base, lang);
  if (!track) return <main className="home"><p><a href="#">{t.back}</a></p><h1>{t.unknownTrack}</h1></main>;
  const steps = track.steps.map((s) => ({ item: resolveRef(s.ref), why: s.why })).filter((x): x is { item: Item; why: string | undefined } => !!x.item);
  const n = steps.filter((s) => done.includes(s.item.ref)).length;
  const nextIndex = steps.findIndex((s) => !done.includes(s.item.ref));
  const mins = steps.reduce((a, s) => a + s.item.minutes, 0);
  const left = steps.filter((s) => !done.includes(s.item.ref)).reduce((a, s) => a + s.item.minutes, 0);
  return (
    <main className="home track">
      <p><a href="#">{t.allTracks}</a></p>
      <h1 className="track-title"><TrackIcon id={track.id} />{track.title}</h1>
      <p className="lede">{track.summary}</p>
      <p className="muted">{track.audience}</p>
      <div className="progress-row">
        <span className="bar-track"><span style={{ width: `${(100 * n) / steps.length}%` }} /></span>
        <span>{t.trackProgress(n, steps.length, hours(left), hours(mins))}</span>
      </div>
      {nextIndex >= 0 && <p><a className="button primary" href={inTrack(steps[nextIndex].item.href, track.id)}>{n === 0 ? t.start : t.continueLabel}: {steps[nextIndex].item.title}</a></p>}
      {nextIndex < 0 && <p>{t.trackComplete(<a href="#">{t.homePage}</a>)}</p>}
      <ol className="steps">
        {steps.map((s, i) => <ItemRow key={s.item.ref} item={s.item} why={s.why} index={i + 1} next={i === nextIndex} track={track.id} />)}
      </ol>
    </main>
  );
}

/** On a page opened from a track: where it sits in the track (top) and the previous and next steps (bottom). */
export function TrackNav({ trackId, refId, place }: { trackId: string; refId: string; place: "top" | "bottom" }) {
  const t = useT();
  const { lang } = useSettings();
  const base = tracks.find((x) => x.id === trackId);
  const track = base && trackIn(base, lang);
  if (!track) return null;
  const refs = track.steps.map((s) => s.ref);
  const i = refs.indexOf(refId);
  if (i < 0) return null;
  const link = (ref: string | undefined) => { const item = ref ? resolveRef(ref) : undefined; return item && { href: inTrack(item.href, track.id), title: item.title }; };
  if (place === "top") {
    return <p className="track-nav at-top"><a href={`#track/${track.id}`}>← {track.title}</a><span className="muted">{t.trackStep(i + 1, refs.length)}</span></p>;
  }
  const prev = link(refs[i - 1]), next = link(refs[i + 1]);
  return (
    <nav className="track-nav at-end" aria-label={t.trackNav}>
      {prev ? <a href={prev.href}><span className="muted">← {t.prevStep}</span>{prev.title}</a> : <span />}
      {next ? <a className="next" href={next.href}><span className="muted">{t.nextStep} →</span>{next.title}</a> : <a className="next" href={`#track/${track.id}`}><span className="muted">{t.trackStep(refs.length, refs.length)}</span>← {track.title}</a>}
    </nav>
  );
}
