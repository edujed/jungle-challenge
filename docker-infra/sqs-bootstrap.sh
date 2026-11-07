#!/bin/sh
# infra/sqs-bootstrap.sh
# Cria as filas FIFO + redrive policy no LocalStack.
# Executado pelo serviço sqs-bootstrap (one-shot, imagem amazon/aws-cli).
# AWS_ENDPOINT_URL é lido nativamente pelo aws CLI v2.
set -e

echo "=== Criando filas SQS ==="

# 1. DLQ (deve existir antes da main queue para o redrive policy)
aws sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

DLQ_URL=$(aws sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query 'QueueUrl' --output text)
echo "DLQ: $DLQ_URL"

# 2. Obter ARN da DLQ para o redrive policy
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)
echo "DLQ ARN: $DLQ_ARN"

# 3. Main queue com redrive policy para a DLQ
# Usamos --cli-input-json para evitar problemas de escaping com JSON aninhado.
MAIN_INPUT=$(cat <<EOF
{
  "QueueName": "wager-transactions.fifo",
  "Attributes": {
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true",
    "RedrivePolicy": "{\"maxReceiveCount\":\"5\",\"deadLetterTargetArn\":\"$DLQ_ARN\"}"
  }
}
EOF
)

aws sqs create-queue --cli-input-json "$MAIN_INPUT"

MAIN_URL=$(aws sqs get-queue-url --queue-name wager-transactions.fifo --query 'QueueUrl' --output text)
echo "Main queue: $MAIN_URL"

# 4. Verificação final
echo ""
echo "=== Filas criadas ==="
aws sqs list-queues --query 'QueueUrls[]' --output table
echo ""
echo "=== Atributos da main queue ==="
aws sqs get-queue-attributes \
  --queue-url "$MAIN_URL" \
  --attribute-names All \
  --query 'Attributes' \
  --output table
echo ""
echo "=== Bootstrap concluído ==="
