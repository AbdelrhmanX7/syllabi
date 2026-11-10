import { useEffect, useState } from 'react';

import { SectionTitle, Surface } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { analyticsConfigured, setUsageSharing, usageSharingOn } from '@/lib/analytics';

/** Settings → Privacy: the anonymous usage counts switch, per device. Hidden when the build sends none. */
export function UsageSection() {
  const [on, setOn] = useState(true);

  useEffect(() => setOn(usageSharingOn()), []);

  if (!analyticsConfigured) return null;

  return (
    <Surface className='p-5'>
      <SectionTitle>Privacy</SectionTitle>
      <ToggleRow
        checked={on}
        hint='Which screens get used and what breaks, so we can fix it. Never your notes, questions, files or grades.'
        label='Share anonymous usage info'
        onChange={(next) => {
          setUsageSharing(next);
          setOn(next);
        }}
      />
    </Surface>
  );
}
