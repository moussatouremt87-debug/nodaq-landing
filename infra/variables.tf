variable "project_id" {
  description = "Scaleway project id (staging)."
  type        = string
}

variable "image_tag" {
  description = "Tag des images conteneurs (sha du commit déployé)."
  type        = string
}

variable "web_origin" {
  description = "Origine publique du front (2e apply — vide au 1er : les domaines n'existent pas encore)."
  type        = string
  default     = ""
}

variable "api_base_url" {
  description = "URL publique de l'API (2e apply, pour AUTH_BASE_URL)."
  type        = string
  default     = ""
}

variable "dns_zone" {
  description = "Zone DNS du domaine, hébergée chez Scaleway (même projet)."
  type        = string
  default     = "nodaq.fr"
}

variable "web_subdomain" {
  description = "Sous-domaine du front dans dns_zone ('' = pas de domaine custom, retour à l'URL Scaleway)."
  type        = string
  default     = "app"
}
