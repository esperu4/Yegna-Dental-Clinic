import { formatEthiopianDate, formatEtTime, parseIsoDate, toEthiopian, utcToLocal } from '@yegna/time';

/** M0 placeholder shell: proves the build, the shared packages and staging deploy. Real screens start in M1. */
export function App() {
  const now = utcToLocal(Date.now());
  return (
    <main>
      <h1>የኛ የጥርስ ክሊኒክ</h1>
      <p>Yegna Dental Clinic</p>
      <p>
        {formatEthiopianDate(toEthiopian(parseIsoDate(now.date)), 'am')} · {formatEtTime(now.minutes, 'am')}
      </p>
      <p class="env">{import.meta.env.MODE}</p>
    </main>
  );
}
