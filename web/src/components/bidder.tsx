import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { BidProject, BidProjectStatus } from "../../../shared/types";
import { timeAgo } from "../lib/api";

const LABEL: Record<BidProjectStatus, string> = {
  new: "Queued", drafting: "Writing", ready: "To review", bidding: "Sending", bid: "Bid placed", skipped: "Skipped", failed: "Failed",
};
const CLS: Record<BidProjectStatus, string> = {
  new: "queued", drafting: "running", ready: "needs_review", bidding: "running", bid: "ready", skipped: "draft", failed: "failed",
};

export function BidStatusPill({ status }: { status: BidProjectStatus }) {
  return <span className={`status ${CLS[status]}`}><span className="dot" />{LABEL[status]}</span>;
}

export const money = (p: Pick<BidProject, "currency">, n: number) => `${p.currency.sign}${n.toLocaleString("en-US")}`;

export function budgetText(p: BidProject) {
  const unit = p.type === "hourly" ? "/hr" : "";
  const range = p.budget.max ? `${money(p, p.budget.min)}–${money(p, p.budget.max)}` : `${money(p, p.budget.min)}+`;
  return `${range}${unit} ${p.currency.code}`;
}

export function BidProjectsTable({ projects, empty }: { projects: BidProject[]; empty?: string }) {
  const nav = useNavigate();
  if (!projects.length) {
    return (
      <div className="empty">
        <h4>No projects here</h4>
        <p>{empty ?? "Projects that match your skills show up here as soon as they're posted."}</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Project</th>
            <th className="hide-sm">Budget</th>
            <th className="hide-sm">Your bid</th>
            <th>Status</th>
            <th className="hide-sm">Posted</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="row" onClick={() => nav(`/bidder/projects/${p.id}`)}>
              <td>
                <div style={{ minWidth: 220 }}>
                  <b style={{ fontWeight: 450 }}>{p.title}</b>
                  <span className="muted" style={{ display: "block", fontSize: 13, marginTop: 2 }}>
                    {p.bidCount} bids · {p.client.country || "Unknown country"}{p.client.paymentVerified ? " · payment verified" : ""}
                    {(p.status === "skipped" || p.status === "failed") && p.note ? ` · ${p.note}` : ""}
                  </span>
                </div>
              </td>
              <td className="hide-sm nowrap">{budgetText(p)}</td>
              <td className="hide-sm nowrap">{p.amount != null && p.status !== "skipped" ? `${money(p, p.amount)}${p.type === "hourly" ? "/hr" : ""}` : "–"}</td>
              <td><BidStatusPill status={p.status} /></td>
              <td className="hide-sm muted nowrap">{timeAgo(p.postedAt)}</td>
              <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
