import { useEffect, useState } from 'react';
export function Probe({ id }: { id: string }) {
  const [value, setValue] = useState(0);
  useEffect(() => { setValue(1); }, []);
  return <div onClick={() => (window as any).x = id}>{value}</div>;
}
