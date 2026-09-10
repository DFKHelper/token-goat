# HAND-DERIVED: standard Terraform HCL syntax written from language knowledge, not from any adapter regex.
resource "aws_s3_bucket" "inventory" {
  bucket = "inventory-data"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

output "bucket_arn" {
  value = aws_s3_bucket.inventory.arn
}
