-- CreateTable
CREATE TABLE "DemoAnchor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "anchorAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoAnchor_pkey" PRIMARY KEY ("id")
);
