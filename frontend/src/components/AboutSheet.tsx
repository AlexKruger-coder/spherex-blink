import { motion } from 'framer-motion';
import { ARCHIVE_CREDITS, DATA_ACKNOWLEDGEMENT, TOMBAUGH } from '../content';

const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mb-2 text-[12px] uppercase tracking-[0.16em] text-haze/80">{children}</h3>
);

export function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <>
      <motion.div
        className="fixed inset-0 z-30 bg-void/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        role="dialog"
        aria-label="About"
        className="fixed bottom-0 right-0 top-0 z-40 w-[min(440px,100vw)] overflow-y-auto border-l border-ash/70 bg-void px-8 py-9"
        initial={{ x: '100%' }}
        animate={{ x: 0, transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] } }}
        exit={{ x: '100%', transition: { duration: 0.24 } }}
      >
        <div className="flex items-start justify-between">
          <h2 className="font-serif text-[34px] font-light text-white">About</h2>
          <button aria-label="Close about" onClick={onClose} className="text-haze hover:text-white">
            ✕
          </button>
        </div>

        <div className="mt-6 space-y-7 text-[16px] leading-relaxed text-fog/90">
          <section>
            <H>What am I looking at</H>
            <p>
              Real infrared images from NASA's SPHEREx space telescope. SPHEREx photographs the whole sky again and again, in many
              wavelengths from 0.75 to 5 microns. Each image here is a patch of sky, made by combining the visits of one period into a single
              "plate".
            </p>
          </section>

          <section>
            <H>How blinking works</H>
            <p>
              Stars stay where they are. Anything that moves jumps when you flip between plates. In <em>Changes only</em>, everything that
              stayed put disappears. What is left is warm where something <em>was</em>, and cool where it is <em>now</em>. In <em>Deep sum</em>,
              plates are stacked together to reveal faint stationary sources.
            </p>
          </section>

          <section>
            <H>The old trick</H>
            <p className="font-serif text-[22px] italic text-white">{TOMBAUGH.title}</p>
            <p className="mt-1">
              {TOMBAUGH.body} He was searching for what Percival Lowell called Planet X. What he found was Pluto, which we no longer count as a
              planet.
            </p>
          </section>

          <section>
            <H>What is, and is not, claimed</H>
            <p>
              We show known objects moving across real data. We do not announce discoveries. Anything unfamiliar would be a candidate for
              follow-up, never a finding. Pictures are built from 6.2″ pixels and then smoothed (or viewed as native pixels), so fine detail is
              interpolated, not seen.
            </p>
          </section>

          <section>
            <H>Data & archive acknowledgements</H>
            <p className="text-[15px] text-haze">{DATA_ACKNOWLEDGEMENT}</p>
            <p className="mt-2.5 text-[14px] text-haze/90">{ARCHIVE_CREDITS}</p>
            <p className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[15px]">
              <a className="link text-fog" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
                NASA/IPAC IRSA SPHEREx
              </a>
              <a className="link text-fog" href="https://www.cosmos.esa.int/web/gaia/dr3" target="_blank" rel="noreferrer">
                ESA Gaia DR3
              </a>
              <a className="link text-fog" href="https://aladin.cds.unistra.fr/" target="_blank" rel="noreferrer">
                CDS Aladin
              </a>
              <a className="link text-fog" href="http://byw.tools/wiseview" target="_blank" rel="noreferrer">
                WiseView
              </a>
              <a className="link text-fog" href="https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/" target="_blank" rel="noreferrer">
                CSA CADC
              </a>
              <a className="link text-fog" href="https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/" target="_blank" rel="noreferrer">
                The challenge
              </a>
            </p>
          </section>
        </div>
      </motion.aside>
    </>
  );
}
