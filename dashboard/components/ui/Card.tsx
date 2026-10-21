export default function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <section className="card" style={style}>{children}</section>;
}
