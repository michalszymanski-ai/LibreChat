# BilleChat — patched ingress-nginx controller
#
# kubernetes/ingress-nginx was archived on 2026-03-24, so controller v1.15.1 is
# its last image and upstream will not ship OS package fixes any more. This
# rebuild keeps the controller as-is and only takes Alpine 3.23 security updates
# for curl/libcurl (8.17.0 → 8.23.0: CVE-2026-87862, CVE-2026-87863).
#
# setup-infrastructure.sh builds it into ACR when the tag is missing and pins
# the controller to its digest. To take a newer Alpine fix, bump
# INGRESS_IMAGE_TAG there and rerun the ingress step.

FROM registry.k8s.io/ingress-nginx/controller:v1.15.1@sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1

USER root
RUN apk add --no-cache 'curl>=8.23.0' 'libcurl>=8.23.0' \
    && curl --version | head -1 \
    && apk info -v 2>/dev/null | grep -E '^(lib)?curl-'
USER www-data
