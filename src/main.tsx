import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { hydrateStoredData } from "./lib/storage";
import "./styles.css";

void hydrateStoredData().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
