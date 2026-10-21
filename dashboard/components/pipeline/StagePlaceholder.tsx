import EngagementList from "@/components/pipeline/EngagementList";
import type { City, PipelineFlorist } from "@/lib/types";

export default function StagePlaceholder({
  title,
  florists,
  cities,
}: {
  title: string;
  florists: PipelineFlorist[];
  cities: City[];
}) {
  return (
    <div className="space-y-3">
      <div
        className="rounded-md border border-dashed px-4 py-3 text-sm text-warn"
        style={{
          borderColor: "color-mix(in srgb, var(--warn) 45%, var(--line))",
          background: "color-mix(in srgb, var(--warn) 10%, transparent)",
        }}
      >
        <span className="font-medium">{title} workflow coming soon.</span> This stage is a
        placeholder — florists currently here are listed below; moving them along is manual for now.
      </div>
      <EngagementList florists={florists} cities={cities} emptyLabel={`No florists in ${title} yet.`} />
    </div>
  );
}
