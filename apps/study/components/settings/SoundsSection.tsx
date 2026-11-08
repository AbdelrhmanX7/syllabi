import { useEffect, useState } from 'react';

import { SectionTitle, Surface } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { clickSoundsOn, playClick, setClickSounds, subscribeClickSounds } from '@/lib/sound/click';

/** Settings → Sounds: the soft click on buttons, per device. */
export function SoundsSection() {
  const [on, setOn] = useState(true);

  useEffect(() => {
    setOn(clickSoundsOn());

    return subscribeClickSounds(() => setOn(clickSoundsOn()));
  }, []);

  return (
    <Surface className='p-5'>
      <SectionTitle>Sounds</SectionTitle>
      <ToggleRow
        checked={on}
        hint='A soft click when you tap a button.'
        label='Button sounds'
        onChange={(next) => {
          setClickSounds(next);
          if (next) playClick();
        }}
      />
    </Surface>
  );
}
