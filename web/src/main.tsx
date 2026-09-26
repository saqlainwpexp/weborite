import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "@fontsource-variable/inter";
import "./app.css";
import Layout from "./layout/Layout";
import Dashboard from "./pages/Dashboard";
import Leads from "./pages/Leads";
import LeadDetail from "./pages/LeadDetail";
import Benchmarks from "./pages/Benchmarks";
import Settings from "./pages/Settings";
import FinderDashboard from "./pages/finder/FinderDashboard";
import FinderLeads from "./pages/finder/FinderLeads";
import FinderLeadDetail from "./pages/finder/FinderLeadDetail";
import FinderSearches from "./pages/finder/FinderSearches";
import BuildsDashboard from "./pages/builds/BuildsDashboard";
import BuildsList from "./pages/builds/BuildsList";
import BuildForm from "./pages/builds/BuildForm";
import BuildDetail from "./pages/builds/BuildDetail";
import WpDashboard from "./pages/wp/WpDashboard";
import WpList from "./pages/wp/WpList";
import WpNew from "./pages/wp/WpNew";
import WpDetail from "./pages/wp/WpDetail";
import SeoDashboard from "./pages/seo/SeoDashboard";
import SeoList from "./pages/seo/SeoList";
import SeoNew from "./pages/seo/SeoNew";
import SeoDetail from "./pages/seo/SeoDetail";
import SeoChecklistTemplate from "./pages/seo/SeoChecklistTemplate";
import CareDashboard from "./pages/care/CareDashboard";
import CareList from "./pages/care/CareList";
import CareNew from "./pages/care/CareNew";
import CareDetail from "./pages/care/CareDetail";
import CommsHome from "./pages/comms/CommsHome";
import CommsAdd from "./pages/comms/CommsAdd";
import CommsView from "./pages/comms/CommsView";
import Campaigns from "./pages/campaigns/Campaigns";
import CampaignDetail from "./pages/campaigns/CampaignDetail";
import AdminOverview from "./pages/admin/AdminOverview";
import AdminClients from "./pages/admin/AdminClients";
import AdminRevenue from "./pages/admin/AdminRevenue";
import { applyStoredBrand } from "./lib/brand";
import { Activation, type LicenseStatus } from "./pages/Activation";
import { api } from "./lib/api";
import { workspaceEnabled } from "../../shared/features";

applyStoredBrand();

// Fade out the startup splash once the app has painted its first frame.
function dismissSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 400);
  }));
}

const DASHBOARD = (
  <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="benchmarks" element={<Benchmarks />} />
          <Route path="settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="settings/:tab" element={<Settings />} />
          <Route path="profile" element={<Navigate to="/settings/profile" replace />} />
          {workspaceEnabled("finder") && <Route path="finder" element={<FinderDashboard />} />}
          {workspaceEnabled("finder") && <Route path="finder/leads" element={<FinderLeads />} />}
          {workspaceEnabled("finder") && <Route path="finder/leads/:id" element={<FinderLeadDetail />} />}
          {workspaceEnabled("finder") && <Route path="finder/searches" element={<FinderSearches />} />}
          {workspaceEnabled("builds") && <Route path="builds" element={<BuildsDashboard />} />}
          {workspaceEnabled("builds") && <Route path="builds/all" element={<BuildsList />} />}
          {workspaceEnabled("builds") && <Route path="builds/new" element={<BuildForm />} />}
          {workspaceEnabled("builds") && <Route path="builds/:id" element={<BuildDetail />} />}
          {workspaceEnabled("builds") && <Route path="builds/:id/edit" element={<BuildForm />} />}
          {workspaceEnabled("wordpress") && <Route path="wp" element={<WpDashboard />} />}
          {workspaceEnabled("wordpress") && <Route path="wp/all" element={<WpList />} />}
          {workspaceEnabled("wordpress") && <Route path="wp/new" element={<WpNew />} />}
          {workspaceEnabled("wordpress") && <Route path="wp/:id" element={<WpDetail />} />}
          {workspaceEnabled("seo") && <Route path="seo" element={<SeoDashboard />} />}
          {workspaceEnabled("seo") && <Route path="seo/all" element={<SeoList />} />}
          {workspaceEnabled("seo") && <Route path="seo/new" element={<SeoNew />} />}
          {workspaceEnabled("seo") && <Route path="seo/checklist" element={<SeoChecklistTemplate />} />}
          {workspaceEnabled("seo") && <Route path="seo/:id" element={<SeoDetail />} />}
          {workspaceEnabled("care") && <Route path="care" element={<CareDashboard />} />}
          {workspaceEnabled("care") && <Route path="care/all" element={<CareList />} />}
          {workspaceEnabled("care") && <Route path="care/new" element={<CareNew />} />}
          {workspaceEnabled("care") && <Route path="care/:id" element={<CareDetail />} />}
          {workspaceEnabled("comms") && <Route path="comms" element={<CommsHome />} />}
          {workspaceEnabled("comms") && <Route path="comms/new" element={<CommsAdd />} />}
          {workspaceEnabled("comms") && <Route path="comms/:id" element={<CommsView />} />}
          {workspaceEnabled("automations") && <Route path="campaigns" element={<Campaigns />} />}
          {workspaceEnabled("automations") && <Route path="campaigns/:id" element={<CampaignDetail />} />}
          {workspaceEnabled("admin") && <Route path="admin" element={<AdminOverview />} />}
          {workspaceEnabled("admin") && <Route path="admin/clients" element={<AdminClients />} />}
          {workspaceEnabled("admin") && <Route path="admin/revenue" element={<AdminRevenue />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
  </BrowserRouter>
);

/** License gate: activate before the dashboard loads; re-checks so a lapsed subscription locks it. */
function Root() {
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const check = () =>
    api<LicenseStatus>("/api/license/status")
      .then(setLic)
      .catch(() => setLic({ bypass: false, activated: false, licensed: false, status: "none", name: "", unreachable: true }));
  useEffect(() => void check(), []);
  useEffect(() => {
    if (lic) dismissSplash();
  }, [lic]);
  if (!lic) return null; // splash stays up until we know
  if (!lic.licensed || lic.onboarded === false) return <Activation status={lic} onActivated={check} />;
  return DASHBOARD;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
