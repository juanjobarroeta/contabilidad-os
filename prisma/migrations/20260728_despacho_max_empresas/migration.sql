-- Tope de empresas por despacho (condicion de la invitacion de onboarding) — aditivo.
ALTER TABLE "Despacho" ADD COLUMN "maxEmpresas" INTEGER;
ALTER TABLE "OnboardingInvite" ADD COLUMN "maxEmpresas" INTEGER;
