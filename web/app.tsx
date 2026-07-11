import { Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { Dashboard } from "./screens/Dashboard";
import { Trades } from "./screens/Trades";
import { TradeDetail } from "./screens/TradeDetail";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

function Soon({ what }: { what: string }) {
  return <div className="empty card">{what} lands in the next iteration.</div>;
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Switch>
        <Route path="/">
          <Layout title="Dashboard">
            <Dashboard />
          </Layout>
        </Route>
        <Route path="/trades">
          <Layout title="Trades">
            <Trades />
          </Layout>
        </Route>
        <Route path="/trades/:id">
          {(params) => (
            <Layout title="Trade detail">
              <TradeDetail id={decodeURIComponent(params.id)} />
            </Layout>
          )}
        </Route>
        <Route path="/positions">
          <Layout title="Open positions">
            <Soon what="Open positions" />
          </Layout>
        </Route>
        <Route path="/journal">
          <Layout title="Weekly journal">
            <Soon what="The weekly journal" />
          </Layout>
        </Route>
        <Route>
          <Layout title="Not found">
            <div className="empty card">Page not found.</div>
          </Layout>
        </Route>
      </Switch>
    </QueryClientProvider>
  );
}
