-- CreateIndex
CREATE INDEX "transactions_fromId_idx" ON "transactions"("fromId");

-- CreateIndex
CREATE INDEX "transactions_toId_idx" ON "transactions"("toId");
