type Variant = "default" | "solid" | "ghost" | "warn";
const CLS: Record<Variant, string> = { default: "btn", solid: "btn btn-solid", ghost: "btn btn-ghost", warn: "btn btn-warn" };

export default function Button({ variant = "default", ...props }: { variant?: Variant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${CLS[variant]} ${props.className ?? ""}`.trim()} />;
}
