import React from "react";

export default function ProviderIcon({ provider }) {
  const viewBox = provider === "yandex" ? "0 0 61 91" : "0 0 24 24";
  return <svg className={`provider-icon provider-icon-${provider}`} viewBox={viewBox} aria-hidden="true"><use href={`/static/social-icons.svg#${provider}`} /></svg>;
}
