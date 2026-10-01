import { Suspense } from "react";
import { OnboardingMascota } from "@/components/onboarding/OnboardingMascota";
import "./onboarding.css";

// El alta guiada por el copiloto. El wizard de formularios sigue en
// /onboarding/manual («Conectar después»: sin e.firma a la mano).
export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="ob" />}>
      <OnboardingMascota />
    </Suspense>
  );
}
