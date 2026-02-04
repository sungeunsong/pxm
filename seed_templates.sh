#!/bin/bash

# API 엔드포인트 설정 (환경에 맞게 포트 수정)
API_URL="http://localhost:3000/api/templates"

echo "Creating HR Onboarding Template..."
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d @seeds/template_hr_onboarding.json
echo -e "\n"

echo "Creating IT Access Request Template..."
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d @seeds/template_it_access.json
echo -e "\n"

echo "Creating Legal Review Template..."
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d @seeds/template_legal_review.json
echo -e "\n"

echo "Creating Sales Discount Template..."
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d @seeds/template_sales_discount.json
echo -e "\n"

echo "Creating Flight Booking Template..."
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d @seeds/template_flight_booking.json
echo -e "\n"

echo "Done! Check the Flow Designer."
