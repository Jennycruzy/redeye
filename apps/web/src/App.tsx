import { lazy, Suspense } from "react";
import { Skeleton } from "./components/bits";
import { Shell } from "./components/Shell";
import { useLocation } from "./lib/router";
import Home from "./pages/Home";

const Start = lazy(() => import("./pages/Start"));
const Record = lazy(() => import("./pages/Record"));
const Run = lazy(() => import("./pages/Run"));
const Stock = lazy(() => import("./pages/Stock"));
const Proof = lazy(() => import("./pages/Proof"));
const Data = lazy(() => import("./pages/Data"));
const Replay = lazy(() => import("./pages/Replay"));
const NotFound = lazy(() => import("./pages/NotFound"));

function Page() {
  const { path } = useLocation();
  if (path === "/") return <Home />;
  if (path === "/start") return <Start />;
  if (path === "/record") return <Record />;
  if (path === "/proof") return <Proof />;
  if (path === "/data") return <Data />;
  if (path === "/replay") return <Replay />;
  const run = /^\/runs\/([\w:-]{1,80})$/.exec(path);
  if (run) return <Run id={run[1]!} />;
  const stock = /^\/t\/([A-Za-z][A-Za-z0-9.-]{0,14})$/.exec(path);
  if (stock) return <Stock ticker={stock[1]!.toUpperCase()} />;
  return <NotFound />;
}

export default function App() {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="wrap section">
            <Skeleton height={360} />
          </div>
        }
      >
        <Page />
      </Suspense>
    </Shell>
  );
}
