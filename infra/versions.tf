# Backend S3 = Scaleway Object Storage (bucket créé par le workflow avant init).
# Credentials via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (= clés Scaleway).

terraform {
  required_version = ">= 1.6"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.49"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    key    = "staging/terraform.tfstate"
    region = "fr-par"
    endpoints = {
      s3 = "https://s3.fr-par.scw.cloud"
    }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    # bucket fourni par -backend-config (nom dérivé du projet, cf. workflow)
  }
}

# Auth du provider par env : SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID.
provider "scaleway" {
  region = "fr-par"
  zone   = "fr-par-1"
}
