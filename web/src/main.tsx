import { StrictMode } from "react";
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
import AdminOverview from "./pages/admin/AdminOverview";
import AdminClients from "./pages/admin/AdminClients";
import AdminRevenue from "./pages/admin/AdminRevenue";
import { applyStoredBrand } from "./lib/brand";

applyStoredBrand();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
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
          <Route path="finder" element={<FinderDashboard />} />
          <Route path="finder/leads" element={<FinderLeads />} />
          <Route path="finder/leads/:id" element={<FinderLeadDetail />} />
          <Route path="finder/searches" element={<FinderSearches />} />
          <Route path="builds" element={<BuildsDashboard />} />
          <Route path="builds/all" element={<BuildsList />} />
          <Route path="builds/new" element={<BuildForm />} />
          <Route path="builds/:id" element={<BuildDetail />} />
          <Route path="builds/:id/edit" element={<BuildForm />} />
          <Route path="wp" element={<WpDashboard />} />
          <Route path="wp/all" element={<WpList />} />
          <Route path="wp/new" element={<WpNew />} />
          <Route path="wp/:id" element={<WpDetail />} />
          <Route path="seo" element={<SeoDashboard />} />
          <Route path="seo/all" element={<SeoList />} />
          <Route path="seo/new" element={<SeoNew />} />
          <Route path="seo/checklist" element={<SeoChecklistTemplate />} />
          <Route path="seo/:id" element={<SeoDetail />} />
          <Route path="care" element={<CareDashboard />} />
          <Route path="care/all" element={<CareList />} />
          <Route path="care/new" element={<CareNew />} />
          <Route path="care/:id" element={<CareDetail />} />
          <Route path="comms" element={<CommsHome />} />
          <Route path="comms/new" element={<CommsAdd />} />
          <Route path="comms/:id" element={<CommsView />} />
          <Route path="admin" element={<AdminOverview />} />
          <Route path="admin/clients" element={<AdminClients />} />
          <Route path="admin/revenue" element={<AdminRevenue />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
