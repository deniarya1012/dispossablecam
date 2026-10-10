import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Our Wedding Camera — Yani & Deni',
  description: 'A shared wedding album, captured by everyone who was there.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
