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

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.dns_zone))
    error_message = "dns_zone doit être un nom de domaine nu (ex. nodaq.fr)."
  }
}

variable "dns_zone_project_id" {
  description = "Projet Scaleway qui possède la zone DNS ('' = même projet que le staging). Le domaine a pu être enregistré dans un autre projet du compte."
  type        = string
  default     = ""
}

variable "web_subdomain" {
  description = "Sous-domaine du front dans dns_zone ('' = pas de domaine custom, retour à l'URL Scaleway). Désactivé tant que la zone nodaq.fr n'est pas accessible au projet (deploy #17 : 403 domain not found)."
  type        = string
  default     = ""

  # Alimente WEB_ORIGIN (trustedOrigins better-auth) : une valeur malformée
  # doit échouer AU PLAN, pas au boot de l'API.
  validation {
    condition     = var.web_subdomain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.web_subdomain))
    error_message = "web_subdomain : un seul label DNS ([a-z0-9-]), ou vide pour désactiver."
  }
}
